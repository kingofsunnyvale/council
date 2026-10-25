import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fixtureModels } from './fixture';
import { random, seal } from '../worker/crypto';
import { createConversation, createTurn, getAttempt } from '../worker/store';
import { streamAttempt } from '../worker/stream';
import { readSSE } from '../shared/sse';
const encoder=new TextEncoder();
const frame=(data: unknown)=>`data: ${JSON.stringify(data)}\r\n\r\n`;
async function connected(n=fixtureModels.length) {
  const f=await fixture();
  f.sql.prepare('INSERT INTO connections VALUES(?,?,?)').run(f.owner,await seal('test-only-provider-key',f.owner,f.env.ENCRYPTION_KEYS!),Date.now());
  const c=await createConversation(f.env,f.owner,fixtureModels.slice(0,n).map(m=>m.id),fixtureModels,random());
  const d=await createTurn(f.env,f.owner,c.id,{prompt:'Find current news and cite sources',search:true,key:random(),version:0},fixtureModels);
  return {...f,d};
}
async function collect(response: Response) { const events=[]; for await(const e of readSSE(response.body!)) events.push(JSON.parse(e)); return events; }
test('SSE handles arbitrary UTF-8 and CRLF splits, comments, multiline data, and bounded frames', async () => {
  const text=':keepalive\r\ndata: hello 🌍\r\ndata: again\r\n\r\ndata: [DONE]\n\n';
  const bytes=encoder.encode(text); const body=new ReadableStream({start(c){for(const b of bytes)c.enqueue(new Uint8Array([b]));c.close();}});
  const events=[];for await(const e of readSSE(body))events.push(e);
  assert.deepEqual(events,['hello 🌍\nagain','[DONE]']);
  await assert.rejects(async()=>{for await(const _ of readSSE(new ReadableStream({start(c){c.enqueue(encoder.encode('data: '+'x'.repeat(600000)));c.close();}}))){}},/too large/);
});
test('all eight upstream requests start before any completes, independently stream, preserve citations and late usage', async t => {
  const f=await connected(); const calls:string[]=[]; let release!:()=>void;const barrier=new Promise<void>(r=>release=r);
  t.mock.method(globalThis,'fetch',async (_url: unknown, options: RequestInit) => {
    const payload=JSON.parse(options.body as string);calls.push(payload.model);
    if(payload.model==='nousresearch/hermes-4-405b'){assert.equal(payload.tools,undefined);assert.deepEqual(payload.reasoning,{enabled:true,exclude:true});}
    else {assert.equal(payload.tools[0].parameters.max_uses,3);assert.equal(payload.tools[0].parameters.engine,'exa');}
    assert.equal(payload.messages.length,1);assert.equal(payload.provider.allow_fallbacks,false);
    if(calls.length===fixtureModels.length)release();await barrier;
    const bytes=encoder.encode(': processing\n\n'+frame({id:'provider-'+calls.indexOf(payload.model),choices:[{delta:{content:payload.model+' 🌍',reasoning:'DO NOT STORE'}}]})+frame({choices:[{delta:{annotations:[{type:'url_citation',url_citation:{url:'https://example.com/news',title:'Actual source'}}]},finish_reason:'stop'}]})+frame({choices:[],usage:{total_tokens:42,cost:0.017}})+'data: [DONE]\n\n');
    return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.slice(i,i+7));c.close();}}),{headers:{'content-type':'text/event-stream'}});
  });
  const responses=await Promise.all(f.d.attempts.map(a=>streamAttempt(new Request('https://worker.example/stream'),f.env,f.ctx,f.owner,a.id)));
  const events=await Promise.all(responses.map(collect));await Promise.all(f.tasks);
  assert.equal(calls.length,fixtureModels.length);assert.equal(new Set(calls).size,fixtureModels.length);
  for(let i=0;i<fixtureModels.length;i++){
    const saved=await getAttempt(f.env,f.owner,f.d.attempts[i].id);
    assert.equal(saved.status,'complete');assert.equal(saved.text,f.d.attempts[i].model_id+' 🌍');
    assert.equal(JSON.parse(saved.usage!).cost,0.017);assert.equal(JSON.parse(saved.citations)[0].title,'Actual source');
    assert.equal(JSON.stringify(saved).includes('DO NOT STORE'),false);
    assert.ok(events[i].some(e=>e.type==='delta'));assert.equal(events[i].at(-1).type,'finished');
  }
});
test('duplicate stream claims bill once; provider errors isolate to one panel', async t => {
  const f=await connected(2);let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return calls===1?Response.json({error:{message:'sensitive provider detail'}},{status:402}):new Response(frame({choices:[{delta:{content:'other succeeds'}}]})+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});});
  const a=f.d.attempts[0];
  const claims=await Promise.allSettled([streamAttempt(new Request('https://w/'),f.env,f.ctx,f.owner,a.id),streamAttempt(new Request('https://w/'),f.env,f.ctx,f.owner,a.id)]);
  assert.equal(claims.filter(r=>r.status==='fulfilled').length,1);
  for(const r of claims)if(r.status==='fulfilled')await collect(r.value);
  await collect(await streamAttempt(new Request('https://w/'),f.env,f.ctx,f.owner,f.d.attempts[1].id));await Promise.all(f.tasks);
  assert.equal(calls,2);const saved=await getAttempt(f.env,f.owner,a.id);assert.equal(saved.status,'error');assert.match(saved.error!,/credits/);assert.equal(saved.error!.includes('sensitive'),false);
  assert.equal((await getAttempt(f.env,f.owner,f.d.attempts[1].id)).status,'complete');
});
test('interrupted SSE preserves partial text and leaves missing usage unknown', async t => {
  const f=await connected(1);
  t.mock.method(globalThis,'fetch',async()=>new Response(frame({choices:[{delta:{content:'partial'}}]}),{headers:{'content-type':'text/event-stream'}}));
  await collect(await streamAttempt(new Request('https://w/'),f.env,f.ctx,f.owner,f.d.attempts[0].id));
  const saved=await getAttempt(f.env,f.owner,f.d.attempts[0].id);assert.equal(saved.status,'interrupted');assert.equal(saved.text,'partial');assert.equal(saved.usage,null);
});
test('cancellation is read from D1 across requests and aborts upstream while retaining partial text', async t => {
  const f=await connected(1);let aborted=false;
  t.mock.method(globalThis,'fetch',async(_u:unknown, options:RequestInit)=>new Response(new ReadableStream({start(c){c.enqueue(encoder.encode(frame({choices:[{delta:{content:'before stop'}}]})));options.signal!.addEventListener('abort',()=>{aborted=true;c.error(new Error('aborted'));});}}),{headers:{'content-type':'text/event-stream'}}));
  const a=f.d.attempts[0];const response=await streamAttempt(new Request('https://w/'),f.env,f.ctx,f.owner,a.id);const collected=collect(response);
  await new Promise(r=>setTimeout(r,20));await f.request('/api/attempts/'+a.id+'/stop','POST',{});
  await collected;await Promise.all(f.tasks);
  const saved=await getAttempt(f.env,f.owner,a.id);assert.equal(aborted,true);assert.equal(saved.status,'stopped');assert.equal(saved.text,'before stop');
});
