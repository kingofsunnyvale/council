import { PUBLIC_ORIGIN } from '../shared/config';
import type { AppEnv } from './env';
import { equal, hash, random, seal, unseal } from './crypto';
import { HttpError, json, readJson, redirect } from './http';

export const origin = (env: AppEnv) => env.APP_ORIGIN || PUBLIC_ORIGIN;
const cookieName = (env: AppEnv) => `${origin(env).startsWith('https:') ? '__Host-' : ''}council-session`;
export function cookie(env: AppEnv, value: string, age: number): string {
  return `${cookieName(env)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${origin(env).startsWith('https:') ? '; Secure' : ''}`;
}
export function getCookie(request: Request, env: AppEnv): string {
  return request.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(cookieName(env) + '='))?.split('=')[1] || '';
}
export async function requireGateway(request: Request, env: AppEnv) {
  if (!env.SERVICE_SECRET || !await equal(request.headers.get('x-council-service') || '', env.SERVICE_SECRET)) throw new HttpError(401, 'Unauthorized.');
}
export function requireOrigin(request: Request, env: AppEnv) {
  if (request.headers.get('origin') !== origin(env)) throw new HttpError(403, 'Invalid request origin.');
}
export type Owner = { id: string; login: string; sessionHash: string };
export async function session(request: Request, env: AppEnv): Promise<Owner> {
  const raw = getCookie(request, env);
  if (!raw) throw new HttpError(401, 'Reopen Council to start a session.');
  const sessionHash = await hash(raw);
  const row = await env.DB.prepare('SELECT u.id, u.login FROM sessions s JOIN users u ON u.id=s.owner_id WHERE s.hash=? AND s.expires_at>? AND s.owner_id=?').bind(sessionHash, Date.now(), env.OWNER_ID).first<{ id: string; login: string }>();
  if (!row) throw new HttpError(401, 'Reopen Council to start a session.');
  return { ...row, login: env.PUBLIC_SHARED === 'true' ? 'Shared workspace' : row.login, sessionHash };
}
// Called only after gateway authentication and Origin validation. In public
// shared mode anyone may join the workspace; this cookie is not an identity check.
export async function openSession(request: Request, env: AppEnv): Promise<Response> {
  try { const owner = await session(request, env); return json({ owner: { id: owner.id, login: owner.login } }); }
  catch (e) { if (!(e instanceof HttpError && e.status === 401)) throw e; }
  const now = Date.now(); const raw = random();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(now),
    env.DB.prepare("INSERT INTO users(id,login,created_at) VALUES(?,'Private workspace',?) ON CONFLICT(id) DO NOTHING").bind(env.OWNER_ID, now),
    env.DB.prepare('INSERT INTO sessions(hash,owner_id,expires_at) VALUES(?,?,?)').bind(await hash(raw), env.OWNER_ID, now + 7 * 86400_000),
  ]);
  return json({ owner: { id: env.OWNER_ID, login: env.PUBLIC_SHARED === 'true' ? 'Shared workspace' : 'Private workspace' } }, 200, { 'Set-Cookie': cookie(env, raw, 7 * 86400) });
}
export async function providerKey(env: AppEnv, owner: string): Promise<string> {
  const row = await env.DB.prepare('SELECT credential FROM connections WHERE owner_id=?').bind(owner).first<{ credential: string }>();
  if (!row || !env.ENCRYPTION_KEYS) throw new HttpError(409, 'Connect your OpenRouter account first.');
  return unseal(row.credential, owner, env.ENCRYPTION_KEYS);
}
export async function startOAuth(env: AppEnv, owner: Owner): Promise<Response> {
  if (!env.ENCRYPTION_KEYS) throw new HttpError(503, 'Account encryption is awaiting configuration.');
  const now = Date.now();
  await env.DB.prepare('DELETE FROM oauth_states WHERE expires_at<?').bind(now).run();
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_states WHERE session_hash=?').bind(owner.sessionHash).first<{ n: number }>();
  if ((count?.n || 0) >= 10) throw new HttpError(429, 'Too many connection requests. Try again in ten minutes.');
  const state = random(); const verifier = random(); const callback = `${origin(env)}/api/auth/openrouter/callback`;
  await env.DB.prepare("INSERT INTO oauth_states(hash,provider,owner_id,session_hash,verifier,callback,expires_at) VALUES(?,'openrouter',?,?,?,?,?)")
    .bind(await hash(state), owner.id, owner.sessionHash, await seal(verifier, owner.id, env.ENCRYPTION_KEYS), callback, now + 600_000).run();
  const url = new URL('https://openrouter.ai/auth');
  url.searchParams.set('state', state); url.searchParams.set('code_challenge', await hash(verifier)); url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('callback_url', callback); url.searchParams.set('key_label', 'Council');
  return json({ url: url.toString() });
}
export async function finishOAuth(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url); const code = url.searchParams.get('code'); const state = url.searchParams.get('state');
  if (!code || code.length > 2048 || !state || state.length > 100 || !env.ENCRYPTION_KEYS) throw new HttpError(400, 'Invalid OAuth callback. Start again.');
  const owner = await session(request, env);
  const row = await env.DB.prepare("DELETE FROM oauth_states WHERE hash=? AND provider='openrouter' AND session_hash=? AND owner_id=? AND expires_at>? RETURNING verifier,callback")
    .bind(await hash(state), owner.sessionHash, owner.id, Date.now()).first<{ verifier: string; callback: string }>();
  if (!row || row.callback !== `${origin(env)}/api/auth/openrouter/callback`) throw new HttpError(400, 'Expired, invalid, or already used OAuth state. Start again.');
  const verifier = await unseal(row.verifier, owner.id, env.ENCRYPTION_KEYS);
  const response = await fetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  });
  if (!response.ok) { await response.body?.cancel(); throw new HttpError(400, 'Authorization exchange failed. Start again.'); }
  const data = await readJson<{ key?: string }>(response, 16_000);
  if (!data.key) throw new HttpError(400, 'OpenRouter authorization failed.');
  await env.DB.prepare('INSERT INTO connections(owner_id,credential,updated_at) VALUES(?,?,?) ON CONFLICT(owner_id) DO UPDATE SET credential=excluded.credential, updated_at=excluded.updated_at')
    .bind(owner.id, await seal(data.key, owner.id, env.ENCRYPTION_KEYS), Date.now()).run();
  return redirect(origin(env) + '/?connected=1');
}
