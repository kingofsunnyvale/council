import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fixtureModels } from './fixture';
import { createConversation, createTurn, getAttempt, history, recover, retry } from '../worker/store';
import { random } from '../worker/crypto';

test('shared turn creation is idempotent and competing tabs cannot fork the sequence', async () => {
  const f=await fixture(); const id=random(); const ids=fixtureModels.map(m=>m.id);
  await createConversation(f.env,f.owner,ids,fixtureModels,id);
  const input={prompt:'One prompt',search:true,key:random(),version:0};
  const duplicates=await Promise.all(Array.from({length:8},()=>createTurn(f.env,f.owner,id,input,fixtureModels)));
  assert.equal(new Set(duplicates.map(d=>d.turns[0].id)).size,1);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM turns').get()!.n,1);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM attempts').get()!.n,fixtureModels.length);
  await assert.rejects(createTurn(f.env,f.owner,id,{...input,prompt:'Different'},fixtureModels),/key/);
  await assert.rejects(createTurn(f.env,f.owner,id,{...input,key:random(),version:1},fixtureModels),/running|changed/);
  f.sql.prepare("UPDATE attempts SET status='complete',text='done'").run();
  const competition=await Promise.allSettled(['first','second'].map(prompt=>createTurn(f.env,f.owner,id,{prompt,search:false,key:random(),version:1},fixtureModels)));
  assert.equal(competition.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM turns').get()!.n,2);
});
test('lineups are immutable, validated live, and enforced on every stored attempt', async () => {
  const f=await fixture(),id=random();
  await createConversation(f.env,f.owner,[fixtureModels[0].id],fixtureModels,id);
  await assert.rejects(createConversation(f.env,f.owner,[fixtureModels[1].id],fixtureModels,id),/pinned/);
  for(const ids of [[],['made/up'],Array(9).fill(fixtureModels[0].id),[fixtureModels[0].id,fixtureModels[0].id]]) await assert.rejects(createConversation(f.env,f.owner,ids,fixtureModels,random()));
  const d=await createTurn(f.env,f.owner,id,{prompt:'Hello',search:false,key:random(),version:0},fixtureModels);
  assert.throws(()=>f.sql.prepare("INSERT INTO attempts(id,turn_id,conversation_id,owner_id,model_id,number,idempotency_key,status,created_at) VALUES(?,?,?,?,?,1,'bad','pending',0)").run(random(),d.turns[0].id,id,f.owner,fixtureModels[1].id),/model_not_pinned/);
  await assert.rejects(getAttempt(f.env,'another-owner',d.attempts[0].id),/not found/);
  assert.equal((await f.request('/api/conversations/'+id,'GET',undefined,{cookie:null})).status,401);
});
test('histories include shared prompts and only that model’s completed answers; retries retain earlier attempts', async () => {
  const f=await fixture(),id=random(); const ids=fixtureModels.slice(0,2).map(m=>m.id);
  await createConversation(f.env,f.owner,ids,fixtureModels,id);
  const d=await createTurn(f.env,f.owner,id,{prompt:'First question',search:false,key:random(),version:0},fixtureModels);
  for(const a of d.attempts) f.sql.prepare("UPDATE attempts SET status='complete',text=? WHERE id=?").run(a.model_id===ids[0]?'Only model A':'Only model B',a.id);
  const a=d.attempts.find(a=>a.model_id===ids[0])!; const key=random();
  const again=await Promise.all([retry(f.env,f.owner,a.id,key),retry(f.env,f.owner,a.id,key)]); assert.equal(again[0].id,again[1].id);
  f.sql.prepare("UPDATE attempts SET status='complete',text='A revised' WHERE id=?").run(again[0].id);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM attempts').get()!.n,3);
  const next=await createTurn(f.env,f.owner,id,{prompt:'Follow up',search:false,key:random(),version:1},fixtureModels);
  const latest=next.attempts.find(x=>x.turn_id===next.turns[1].id && x.model_id===ids[0])!;
  assert.deepEqual(await history(f.env,await getAttempt(f.env,f.owner,latest.id)),[{role:'user',content:'First question'},{role:'assistant',content:'A revised'},{role:'user',content:'Follow up'}]);
  await assert.rejects(retry(f.env,f.owner,again[0].id,random()),/latest/);
  assert.equal(JSON.stringify(await history(f.env,await getAttempt(f.env,f.owner,latest.id))).includes('model B'),false);
});
test('dead running and never-started attempts become recoverable and keep partials', async () => {
  const f=await fixture(),id=random();
  await createConversation(f.env,f.owner,fixtureModels.slice(0,2).map(m=>m.id),fixtureModels,id);
  const d=await createTurn(f.env,f.owner,id,{prompt:'Hello',search:false,key:random(),version:0},fixtureModels);
  f.sql.prepare("UPDATE attempts SET status='running',lease_until=0,text='Partial' WHERE id=?").run(d.attempts[0].id);
  f.sql.prepare('UPDATE attempts SET created_at=0 WHERE id=?').run(d.attempts[1].id);
  await recover(f.env,f.owner);
  assert.equal((await getAttempt(f.env,f.owner,d.attempts[0].id)).status,'interrupted');
  assert.equal((await getAttempt(f.env,f.owner,d.attempts[0].id)).text,'Partial');
  assert.equal((await getAttempt(f.env,f.owner,d.attempts[1].id)).status,'interrupted');
  assert.equal((await retry(f.env,f.owner,d.attempts[0].id,random())).status,'pending');
});
test('request limits reject oversized JSON, prompts, and malformed submissions', async () => {
  const f=await fixture();
  const response=await f.request('/api/conversations','POST',{padding:'x'.repeat(100_001)});assert.equal(response.status,413);
  const id=random();await createConversation(f.env,f.owner,[fixtureModels[0].id],fixtureModels,id);
  await assert.rejects(createTurn(f.env,f.owner,id,{prompt:'x'.repeat(24001),search:false,key:random(),version:0},fixtureModels),/Invalid/);
});
