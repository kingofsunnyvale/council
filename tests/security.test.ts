import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fixtureModels } from './fixture';
import { hash, random, seal, unseal } from '../worker/crypto';
import { safeUrl } from '../shared/config';
import { parameters } from '../worker/catalog';
import { reportedUsage, returnedCitations } from '../worker/stream';

test('health reads D1, remains non-sensitive, and rejects mutation', async () => {
  const f = await fixture();
  assert.deepEqual(await (await f.request('/health')).json(), { service: 'council', status:'ok', database:'connected' });
  assert.equal((await f.request('/health','POST')).status,405);
  f.sql.close(); assert.equal((await f.request('/health')).status,503);
});
test('every private API rejects direct access, spoofed identity, and missing sessions', async () => {
  const f=await fixture();
  for (const path of ['/api/session','/api/models','/api/account','/api/conversations','/api/attempts/a/stream','/api/auth/openrouter/start']) {
    assert.equal((await f.request(path, path.endsWith('stream') || path.endsWith('start') ? 'POST' : 'GET', undefined, { 'x-council-service':null, 'oai-user-id':f.owner })).status,401,path);
    assert.equal((await f.request(path,'GET',undefined,{ cookie:null })).status,401,path);
  }
  assert.equal((await f.request('/api/auth/openrouter/start','POST',{}, { origin:'https://evil.example' })).status,403);
  assert.equal((await f.request('/api/conversations','POST',{}, { origin:null })).status,403);
  assert.equal((await f.request('/api/auth/openrouter/callback?code=test&state=test','GET',undefined,{'x-council-service':null})).status,401);
  f.sql.prepare('UPDATE sessions SET expires_at=0').run(); assert.equal((await f.request('/api/session')).status,401);
});
test('deployment-gated sessions require the private gateway and same-origin POST', async () => {
  const f=await fixture();
  assert.equal((await f.request('/api/session','POST',{}, {'x-council-service':null,cookie:null})).status,401);
  assert.equal((await f.request('/api/session','POST',{}, {origin:'https://evil.example',cookie:null})).status,403);
  const opened=await f.request('/api/session','POST',{}, {cookie:null});
  assert.equal(opened.status,200); assert.match(opened.headers.get('set-cookie')!,/HttpOnly; SameSite=Lax/);
  assert.match(opened.headers.get('set-cookie')!,/Secure/);
  assert.equal((await opened.json()).owner.id,f.owner);
  const sessionCookie=opened.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await f.request('/api/session','GET',undefined,{cookie:sessionCookie})).status,200);
});
test('OpenRouter exchanges once, encrypts credentials, rejects expired states, and disconnects', async t => {
  const f=await fixture(); const start=await f.request('/api/auth/openrouter/start','POST',{}); const url=new URL((await start.json()).url); const state=url.searchParams.get('state');
  let exchanges=0;
  t.mock.method(globalThis,'fetch',async (_u: unknown, options: RequestInit) => { exchanges++; assert.equal(JSON.parse(options.body as string).code_challenge_method,'S256'); return Response.json({key:'fixture-provider-key'}); });
  const path='/api/auth/openrouter/callback?code=test&state='+state;
  assert.match((await f.request(path,'GET',undefined,{cookie:null})).headers.get('location')!,/auth_error/); assert.equal(exchanges,0);
  assert.equal((await f.request(path)).headers.get('location'),f.env.APP_ORIGIN+'/?connected=1');
  const encrypted=f.sql.prepare('SELECT credential FROM connections').get()!.credential as string;
  assert.equal(encrypted.includes('fixture-provider-key'),false); assert.equal(await unseal(encrypted,f.owner,f.env.ENCRYPTION_KEYS!),'fixture-provider-key');
  await assert.rejects(unseal(encrypted,'another-owner',f.env.ENCRYPTION_KEYS!));
  await f.request(path); assert.equal(exchanges,1);
  const next=new URL((await (await f.request('/api/auth/openrouter/start','POST',{})).json()).url);
  f.sql.prepare('UPDATE oauth_states SET expires_at=0').run(); await f.request('/api/auth/openrouter/callback?code=test&state='+next.searchParams.get('state')); assert.equal(exchanges,1);
  assert.equal((await f.request('/api/account','DELETE')).status,200); assert.equal(f.sql.prepare('SELECT count(*) AS n FROM connections').get()!.n,0);
});
test('encryption supports version rotation with fresh nonces and rejects tampering', async () => {
  const k1=random(), k2=random(); const old=JSON.stringify({current:'v1',keys:{v1:k1}}); const ring=JSON.stringify({current:'v2',keys:{v1:k1,v2:k2}});
  const a=await seal('secret','owner',old),b=await seal('secret','owner',old); assert.notEqual(a,b);
  assert.equal(await unseal(a,'owner',ring),'secret'); assert.match(await seal('secret','owner',ring),/^v2\./);
  await assert.rejects(unseal(a.slice(0,-8)+'AAAAAAAA','owner',ring));
});
test('public shared sessions can chat but cannot inspect key limits or change credentials', async t => {
  const f=await fixture(); f.env.PUBLIC_SHARED='true';
  const encrypted=await seal('test-shared-key',f.owner,f.env.ENCRYPTION_KEYS!);
  f.sql.prepare('INSERT INTO connections VALUES(?,?,?)').run(f.owner,encrypted,Date.now());
  t.mock.method(globalThis,'fetch',async()=>Response.json({data:{limit_remaining:100,usage:12,is_free_tier:false}}));
  assert.deepEqual(await (await f.request('/api/account')).json(),{connected:true,valid:true,managed:true});
  const opened=await f.request('/api/session','POST',{}, {cookie:null});
  assert.equal(opened.status,200); assert.equal((await opened.json()).owner.login,'Shared workspace');
  const visitorCookie=opened.headers.get('set-cookie')!.split(';')[0];
  const c=await (await f.request('/api/conversations','POST',{id:random(),models:[fixtureModels[0].id]})).json();
  assert.equal((await f.request('/api/conversations/'+c.id,'GET',undefined,{cookie:visitorCookie})).status,200);
  assert.equal((await f.request('/api/account','DELETE')).status,403);
  assert.equal((await f.request('/api/auth/openrouter/start','POST',{})).status,403);
  assert.equal((await f.request('/api/auth/openrouter/callback?code=test&state=test')).status,403);
  assert.equal(f.sql.prepare('SELECT credential FROM connections').get()!.credential,encrypted);
});
test('model parameters enforce exact IDs, high reasoning, caps, and independent Exa limits', () => {
  const result=parameters(fixtureModels[0],true);
  assert.equal(result.model,fixtureModels[0].id); assert.equal(result.max_tokens,32768);
  assert.deepEqual(result.reasoning,{effort:'high',exclude:true});
  assert.deepEqual(result.tools![0].parameters,{engine:'exa',mode:'auto',max_uses:3,max_results:5,max_total_results:15});
  assert.equal('tools' in parameters(fixtureModels[0],false),false);
  assert.throws(()=>parameters({...fixtureModels[0],supported_parameters:['max_tokens']},true));
  assert.equal(parameters({...fixtureModels[0],top_provider:{max_completion_tokens:4096}},false).max_tokens,4096);
});
test('citations reject unsafe links and absent usage remains unknown', () => {
  for(const url of ['javascript:alert(1)','data:text/html,hi','file:///etc/passwd','https://user:pass@example.com']) assert.equal(safeUrl(url),undefined);
  assert.deepEqual(returnedCitations([{type:'url_citation',url_citation:{url:'javascript:evil',title:'bad'}},{type:'url_citation',url_citation:{url:'https://example.com',title:'Real'}}]),[{url:'https://example.com/',title:'Real'}]);
  assert.equal(reportedUsage(undefined),null); assert.equal(reportedUsage({cost:'unknown'}),null);
  assert.deepEqual(reportedUsage({cost:0,total_tokens:17,secret:'ignored'}),{total_tokens:17,cost:0});
});
