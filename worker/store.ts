import { LEASE_MS, MAX_PROMPT, type Attempt, type Conversation, type ConversationDetail, type Turn, type Model } from '../shared/config';
import type { AppEnv } from './env';
import { HttpError, validKey } from './http';
import { parameters, validateModels } from './catalog';

export type AttemptRow = Omit<Attempt, 'citations' | 'usage'> & { citations: string; usage: string | null; owner_id: string; lease_until: number | null; cancel_requested: number };
type ConversationRow = Omit<Conversation, 'models'> & { models: string };
export function decodeAttempt(row: AttemptRow): Attempt {
  const { owner_id: _owner, lease_until: _lease, cancel_requested: _cancel, ...a } = row;
  return { ...a, citations: JSON.parse(row.citations), usage: row.usage ? JSON.parse(row.usage) : null };
}
export async function recover(env: AppEnv, owner: string) {
  const now = Date.now();
  await env.DB.prepare("UPDATE attempts SET status=CASE WHEN cancel_requested=1 THEN 'stopped' ELSE 'interrupted' END, error=CASE WHEN cancel_requested=1 THEN NULL ELSE 'Connection interrupted. Retry explicitly to continue.' END, finished_at=?, lease_until=NULL WHERE owner_id=? AND ((status='running' AND lease_until<?) OR (status='pending' AND created_at<?))")
    .bind(now, owner, now, now - LEASE_MS).run();
}
export async function conversation(env: AppEnv, owner: string, id: string): Promise<Conversation> {
  const row = await env.DB.prepare('SELECT id,title,models,version,created_at,updated_at FROM conversations WHERE id=? AND owner_id=?').bind(id, owner).first<ConversationRow>();
  if (!row) throw new HttpError(404, 'Conversation not found.');
  return { ...row, models: JSON.parse(row.models) };
}
export async function detail(env: AppEnv, owner: string, id: string): Promise<ConversationDetail> {
  const c = await conversation(env, owner, id);
  const [turns, attempts] = await Promise.all([
    env.DB.prepare('SELECT id,sequence,prompt,search,created_at FROM turns WHERE conversation_id=? AND owner_id=? ORDER BY sequence').bind(id, owner).all<Turn>(),
    env.DB.prepare('SELECT * FROM attempts WHERE conversation_id=? AND owner_id=? ORDER BY created_at,number').bind(id, owner).all<AttemptRow>(),
  ]);
  return { conversation: c, turns: turns.results, attempts: attempts.results.map(decodeAttempt) };
}
export async function createConversation(env: AppEnv, owner: string, ids: unknown, models: Model[], id: unknown): Promise<Conversation> {
  validateModels(ids, models);
  if (!validKey(id)) throw new HttpError(400, 'Invalid conversation identifier.');
  const now = Date.now();
  await env.DB.prepare("INSERT INTO conversations(id,owner_id,title,models,created_at,updated_at) VALUES(?,?,'New conversation',?,?,?) ON CONFLICT(id) DO NOTHING").bind(id, owner, JSON.stringify(ids), now, now).run();
  const c = await conversation(env, owner, id);
  if (JSON.stringify(c.models) !== JSON.stringify(ids)) throw new HttpError(409, 'Conversation models are pinned. Start a new conversation.');
  return c;
}
export async function createTurn(env: AppEnv, owner: string, id: string, input: { prompt?: unknown; search?: unknown; key?: unknown; version?: unknown }, models: Model[]) {
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > MAX_PROMPT || !validKey(input.key) || !Number.isInteger(input.version) || typeof input.search !== 'boolean') throw new HttpError(400, 'Invalid prompt, version, or request key.');
  const prompt = input.prompt.trim(); const c = await conversation(env, owner, id);
  const duplicate = await env.DB.prepare('SELECT id,prompt,search FROM turns WHERE conversation_id=? AND owner_id=? AND idempotency_key=?').bind(id, owner, input.key).first<{ id: string; prompt: string; search: number }>();
  if (duplicate) {
    if (duplicate.prompt !== prompt || duplicate.search !== Number(input.search)) throw new HttpError(409, 'Request key was already used for another prompt.');
    return detail(env, owner, id);
  }
  validateModels(c.models, models);
  for (const modelId of c.models) parameters(models.find(m => m.id === modelId)!, input.search);
  const turnId = crypto.randomUUID(); const now = Date.now();
  const inserts = c.models.map(model => env.DB.prepare("INSERT INTO attempts(id,turn_id,conversation_id,owner_id,model_id,number,idempotency_key,status,created_at) SELECT ?,id,conversation_id,owner_id,?,1,'initial','pending',? FROM turns WHERE id=? AND owner_id=?")
    .bind(crypto.randomUUID(), model, now, turnId, owner));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO turns(id,conversation_id,owner_id,sequence,idempotency_key,prompt,search,created_at) SELECT ?,id,owner_id,version+1,?,?,?,? FROM conversations WHERE id=? AND owner_id=? AND version=? AND NOT EXISTS(SELECT 1 FROM attempts WHERE conversation_id=? AND status IN ('pending','running')) ON CONFLICT DO NOTHING")
      .bind(turnId, input.key, prompt, Number(input.search), now, id, owner, input.version, id),
    ...inserts,
    env.DB.prepare('UPDATE conversations SET version=version+1,updated_at=?,title=CASE WHEN version=0 THEN ? ELSE title END WHERE id=? AND owner_id=? AND EXISTS(SELECT 1 FROM turns WHERE id=?)').bind(now, prompt.slice(0,80), id, owner, turnId),
  ]);
  const created = await env.DB.prepare('SELECT id,prompt,search FROM turns WHERE conversation_id=? AND owner_id=? AND idempotency_key=?').bind(id, owner, input.key).first<{ id: string; prompt: string; search: number }>();
  if (!created) throw new HttpError(409, 'Conversation changed in another tab or a response is still running. Reload before sending.');
  if (created.prompt !== prompt || created.search !== Number(input.search)) throw new HttpError(409, 'Request key was already used for another prompt.');
  return detail(env, owner, id);
}
export async function getAttempt(env: AppEnv, owner: string, id: string): Promise<AttemptRow> {
  const row = await env.DB.prepare('SELECT * FROM attempts WHERE id=? AND owner_id=?').bind(id, owner).first<AttemptRow>();
  if (!row) throw new HttpError(404, 'Response not found.'); return row;
}
export async function retry(env: AppEnv, owner: string, previous: string, key: unknown): Promise<Attempt> {
  if (!validKey(key)) throw new HttpError(400, 'Invalid retry key.');
  const a = await getAttempt(env, owner, previous);
  const existing = await env.DB.prepare('SELECT * FROM attempts WHERE turn_id=? AND owner_id=? AND model_id=? AND idempotency_key=?').bind(a.turn_id, owner, a.model_id, key).first<AttemptRow>();
  if (existing) return decodeAttempt(existing);
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO attempts(id,turn_id,conversation_id,owner_id,model_id,number,idempotency_key,status,created_at) SELECT ?,a.turn_id,a.conversation_id,a.owner_id,a.model_id,a.number+1,?,'pending',? FROM attempts a JOIN turns t ON t.id=a.turn_id JOIN conversations c ON c.id=a.conversation_id WHERE a.id=? AND a.owner_id=? AND a.status NOT IN ('pending','running') AND t.sequence=c.version AND NOT EXISTS(SELECT 1 FROM attempts newer WHERE newer.turn_id=a.turn_id AND newer.model_id=a.model_id AND newer.number>a.number) ON CONFLICT DO NOTHING")
    .bind(id, key, Date.now(), previous, owner).run();
  const created = await env.DB.prepare('SELECT * FROM attempts WHERE turn_id=? AND owner_id=? AND model_id=? AND idempotency_key=?').bind(a.turn_id, owner, a.model_id, key).first<AttemptRow>();
  if (!created) throw new HttpError(409, 'Only the latest response in the latest turn can be retried, once the previous attempt has stopped.');
  return decodeAttempt(created);
}
export async function history(env: AppEnv, a: AttemptRow) {
  const turns = await env.DB.prepare('SELECT id,prompt,sequence FROM turns WHERE conversation_id=? AND owner_id=? AND sequence<=(SELECT sequence FROM turns WHERE id=?) ORDER BY sequence').bind(a.conversation_id, a.owner_id, a.turn_id).all<{ id: string; prompt: string }>();
  const answers = await env.DB.prepare("SELECT turn_id,text,number FROM attempts WHERE conversation_id=? AND owner_id=? AND model_id=? AND text!='' AND status='complete' ORDER BY number DESC").bind(a.conversation_id, a.owner_id, a.model_id).all<{ turn_id: string; text: string; number: number }>();
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const turn of turns.results) {
    messages.push({ role: 'user', content: turn.prompt });
    if (turn.id !== a.turn_id) { const answer = answers.results.find(x => x.turn_id === turn.id); if (answer) messages.push({ role: 'assistant', content: answer.text }); }
  }
  if (messages.reduce((n,m) => n + m.content.length, 0) > 1_000_000) throw new HttpError(400, 'This conversation is too long. Start a new conversation.');
  return messages;
}
