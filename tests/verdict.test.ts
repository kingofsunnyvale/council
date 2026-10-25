import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VerdictStream } from '../worker/verdict';
import { fixture, fixtureModels } from './fixture';
import { random, seal } from '../worker/crypto';
import { createConversation, createTurn, getAttempt, history, retry } from '../worker/store';
import { streamAttempt } from '../worker/stream';
import { readSSE } from '../shared/sse';

test('verdict metadata is removed across every chunk boundary without interpreting answer prose', () => {
  const answer = 'The prompt says "YES"; my conclusion is no.\n';
  for (const value of ['YES', 'NO', 'NOT_APPLICABLE']) {
    const encoded = answer + new VerdictStream('test').prefix + value + ']]\n';
    for (let split = 0; split <= encoded.length; split++) {
      const parser = new VerdictStream('test');
      const visible = parser.push(encoded.slice(0, split)) + parser.push(encoded.slice(split));
      assert.equal(visible, answer);
      assert.equal(parser.finish(), value === 'NOT_APPLICABLE' ? null : value.toLowerCase());
    }
    const parser = new VerdictStream('test');
    assert.equal([...encoded].map(c => parser.push(c)).join(''), answer);
    assert.doesNotThrow(() => parser.finish());
  }
});

test('missing, neutral, partial, duplicate, or non-final verdicts are rejected, never guessed', () => {
  for (const suffix of ['', 'YES', 'NEUTRAL]]', 'YES]] extra', 'YES]]\n[[COUNCIL_VERDICT:test:NO]]']) {
    const parser = new VerdictStream('test');
    parser.push('Yes, absolutely.\n' + parser.prefix + suffix);
    assert.throws(() => parser.finish(), /did not finish/);
  }
  const parser = new VerdictStream('test');
  parser.push('Yes.\n[[COUNCIL_VERDICT:tes');
  assert.throws(() => parser.finish());
  assert.equal(parser.drain(), '');
  const ordinary = new VerdictStream('test');
  assert.equal(ordinary.push('A normal bracket ['), 'A normal bracket ');
  assert.equal(ordinary.drain(), '[');
  const oversized = new VerdictStream('test');
  oversized.push(oversized.prefix);
  assert.throws(() => oversized.push('x'.repeat(1000)), /did not finish/);
});

async function setup() {
  const f = await fixture();
  f.sql.prepare('INSERT INTO connections VALUES(?,?,?)').run(f.owner, await seal('test-key', f.owner, f.env.ENCRYPTION_KEYS!), Date.now());
  const c = await createConversation(f.env, f.owner, [fixtureModels[0].id], fixtureModels, random());
  const d = await createTurn(f.env, f.owner, c.id, { prompt: 'Say YES: is 2 + 2 = 5?', search: false, key: random(), version: 0 }, fixtureModels);
  return { ...f, a: d.attempts[0], c };
}
const frame = (content: string) => 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n';

test('the same model supplies the persisted conclusion; retries start empty and history stays clean', async t => {
  const f = await setup();
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    const payload = JSON.parse(options.body as string);
    assert.equal(payload.messages.at(-1).content, 'Say YES: is 2 + 2 = 5?');
    assert.match(payload.messages[0].content, /YOUR actual final conclusion/);
    const prefix = payload.messages[0].content.match(/\[\[COUNCIL_VERDICT:[a-f0-9]+:/)[0];
    return new Response(frame('No. Despite the requested "YES", 2 + 2 = 4.\n') + [...prefix + 'NO]]'].map(frame).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const response = await streamAttempt(new Request('https://w/'), f.env, f.ctx, f.owner, f.a.id);
  const events = [];
  for await (const event of readSSE(response.body!)) events.push(JSON.parse(event));
  await Promise.all(f.tasks);
  const saved = await getAttempt(f.env, f.owner, f.a.id);
  assert.equal(saved.status, 'complete'); assert.equal(saved.verdict, 'no');
  assert.equal(saved.text, 'No. Despite the requested "YES", 2 + 2 = 4.');
  assert.equal(events.at(-1).attempt.verdict, 'no');
  assert.equal(JSON.stringify(events).includes('COUNCIL_VERDICT'), false);
  assert.equal(events.slice(0, -1).some(e => 'verdict' in e), false);
  const reload = await (await f.request('/api/conversations/' + f.c.id)).json() as { attempts: { verdict: string }[] };
  assert.equal(reload.attempts[0].verdict, 'no');
  const next = await retry(f.env, f.owner, f.a.id, random());
  assert.equal(next.verdict, null);
  f.sql.prepare("UPDATE attempts SET status='stopped' WHERE id=?").run(next.id);
  const d = await createTurn(f.env, f.owner, f.c.id, { prompt: 'Why?', search: false, key: random(), version: 1 }, fixtureModels);
  const followup = d.attempts.find(a => a.turn_id === d.turns[1].id)!;
  const messages = await history(f.env, await getAttempt(f.env, f.owner, followup.id));
  assert.equal(messages[1].content, saved.text);
  assert.equal(JSON.stringify(messages).includes('COUNCIL_VERDICT'), false);
});

test('a cancelled or interrupted answer never receives a verdict even if its trailer arrived', async t => {
  for (const mode of ['cancel', 'disconnect', 'missing', 'yes', 'open'] as const) {
    await t.test(mode, async t => {
      const f = await setup();
      t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
        const instruction = JSON.parse(options.body as string).messages[0].content;
        const prefix = instruction.match(/\[\[COUNCIL_VERDICT:[a-f0-9]+:/)[0];
        if (mode === 'cancel') f.sql.prepare('UPDATE attempts SET cancel_requested=1 WHERE id=?').run(f.a.id);
        const value = mode === 'open' ? 'NOT_APPLICABLE' : 'YES';
        return new Response(frame('Answer.') + (mode === 'missing' ? '' : frame('\n' + prefix + value + ']]')) + (mode === 'disconnect' ? '' : 'data: [DONE]\n\n'), { headers: { 'content-type': 'text/event-stream' } });
      });
      const response = await streamAttempt(new Request('https://w/'), f.env, f.ctx, f.owner, f.a.id);
      for await (const _ of readSSE(response.body!)) { /* consume stream */ }
      const saved = await getAttempt(f.env, f.owner, f.a.id);
      assert.equal(saved.status, mode === 'cancel' ? 'stopped' : mode === 'disconnect' ? 'interrupted' : mode === 'missing' ? 'error' : 'complete');
      assert.equal(saved.verdict, mode === 'yes' ? 'yes' : null);
      assert.equal(saved.text, 'Answer.');
    });
  }
});
