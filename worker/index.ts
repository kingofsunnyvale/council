import type { AppEnv } from './env';
import { cookie, finishOAuth, openSession, origin, providerKey, requireGateway, requireOrigin, session, startOAuth } from './auth';
import { catalog, missingRequested } from './catalog';
import { HttpError, json, readJson, redirect } from './http';
import { conversation, createConversation, createTurn, detail, getAttempt, recover, retry } from './store';
import { streamAttempt } from './stream';

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname; const method = request.method;
    try {
      if (path === '/health') {
        if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
        try {
          const result = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
          if (result?.ok !== 1) throw new Error();
          return json({ service: 'council', status: 'ok', database: 'connected' });
        } catch { return json({ service: 'council', status: 'unavailable' }, 503); }
      }
      await requireGateway(request, env);
      if (!['GET','POST','DELETE'].includes(method)) throw new HttpError(405, 'Method not allowed.');
      if (method !== 'GET') requireOrigin(request, env);
      if (path === '/api/session' && method === 'POST') return await openSession(request, env);
      const owner = await session(request, env);
      if (path === '/api/session' && method === 'GET') return json({ owner: { id: owner.id, login: owner.login } });
      if (path === '/api/auth/logout' && method === 'POST') {
        await env.DB.prepare('DELETE FROM sessions WHERE hash=?').bind(owner.sessionHash).run();
        return json({ ok: true }, 200, { 'Set-Cookie': cookie(env, '', 0) });
      }
      if (path === '/api/auth/openrouter/start' && method === 'POST') return await startOAuth(env, owner);
      if (path === '/api/auth/openrouter/callback' && method === 'GET') return await finishOAuth(request, env);
      if (path === '/api/account' && method === 'GET') {
        const exists = await env.DB.prepare('SELECT owner_id FROM connections WHERE owner_id=?').bind(owner.id).first();
        if (!exists) return json({ connected: false });
        try {
          const key = await providerKey(env, owner.id);
          const response = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
          if (!response.ok) { await response.body?.cancel(); return json({ connected: true, valid: false, error: 'OpenRouter could not verify this key. Reconnect or try again.' }); }
          const body = await readJson<{ data: { limit_remaining?: number | null; usage?: number; is_free_tier?: boolean } }>(response, 32_000);
          return json({ connected: true, valid: true, limitRemaining: body.data.limit_remaining ?? null, usage: body.data.usage ?? null, freeTier: body.data.is_free_tier ?? null });
        } catch { return json({ connected: true, valid: false, error: 'Account status is temporarily unavailable.' }); }
      }
      if (path === '/api/account' && method === 'DELETE') {
        await env.DB.batch([
          env.DB.prepare("UPDATE attempts SET cancel_requested=1,status=CASE WHEN status='pending' THEN 'stopped' ELSE status END,finished_at=CASE WHEN status='pending' THEN ? ELSE finished_at END WHERE owner_id=? AND status IN ('pending','running')").bind(Date.now(), owner.id),
          env.DB.prepare('DELETE FROM oauth_states WHERE owner_id=?').bind(owner.id),
          env.DB.prepare('DELETE FROM connections WHERE owner_id=?').bind(owner.id),
        ]);
        return json({ ok: true });
      }
      if (path === '/api/models' && method === 'GET') {
        const data = await catalog(env); return json({ ...data, missing: missingRequested(data.models) });
      }
      await recover(env, owner.id);
      if (path === '/api/conversations' && method === 'GET') {
        const rows = await env.DB.prepare('SELECT id,title,models,version,created_at,updated_at FROM conversations WHERE owner_id=? ORDER BY updated_at DESC LIMIT 100').bind(owner.id).all<{ models: string }>();
        return json({ conversations: rows.results.map(c => ({ ...c, models: JSON.parse(c.models) })) });
      }
      if (path === '/api/conversations' && method === 'POST') {
        const body = await readJson<{ models: unknown; id: unknown }>(request);
        return json(await createConversation(env, owner.id, body.models, (await catalog(env)).models, body.id), 201);
      }
      const match = /^\/api\/conversations\/([\w-]+)(?:\/(turns|stop))?$/.exec(path);
      if (match) {
        const [, id, action] = match;
        if (!action && method === 'GET') return json(await detail(env, owner.id, id));
        if (action === 'turns' && method === 'POST') {
          await providerKey(env, owner.id);
          return json(await createTurn(env, owner.id, id, await readJson(request), (await catalog(env)).models));
        }
        if (action === 'stop' && method === 'POST') {
          await conversation(env, owner.id, id);
          await env.DB.prepare("UPDATE attempts SET cancel_requested=1,status=CASE WHEN status='pending' THEN 'stopped' ELSE status END,finished_at=CASE WHEN status='pending' THEN ? ELSE finished_at END WHERE conversation_id=? AND owner_id=? AND status IN ('pending','running')").bind(Date.now(), id, owner.id).run();
          return json({ ok: true });
        }
      }
      const attemptMatch = /^\/api\/attempts\/([\w-]+)\/(stream|stop|retry)$/.exec(path);
      if (attemptMatch && method === 'POST') {
        const [, id, action] = attemptMatch;
        if (action === 'stream') return await streamAttempt(request, env, ctx, owner.id, id);
        if (action === 'retry') {
          await providerKey(env, owner.id); const body = await readJson<{ key: unknown }>(request);
          return json(await retry(env, owner.id, id, body.key), 201);
        }
        await getAttempt(env, owner.id, id);
        await env.DB.prepare("UPDATE attempts SET cancel_requested=1,status=CASE WHEN status='pending' THEN 'stopped' ELSE status END,finished_at=CASE WHEN status='pending' THEN ? ELSE finished_at END WHERE id=? AND owner_id=? AND status IN ('pending','running')").bind(Date.now(), id, owner.id).run();
        return json({ ok: true });
      }
      return json({ error: 'Not found.' }, 404);
    } catch (error) {
      // Never log request URLs, OAuth codes, raw upstream errors, or chat content.
      if (path.endsWith('/callback')) return redirect(origin(env) + '/?auth_error=failed');
      return json({ error: error instanceof HttpError ? error.message : 'The request could not be completed. Please retry.' }, error instanceof HttpError ? error.status : 500);
    }
  },
} satisfies ExportedHandler<AppEnv>;
