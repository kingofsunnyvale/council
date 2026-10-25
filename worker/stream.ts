import { LEASE_MS, MAX_STREAM_MS, safeUrl, type Citation, type Usage, type Verdict } from '../shared/config';
import { readSSE, sse } from '../shared/sse';
import type { AppEnv } from './env';
import { catalog, parameters } from './catalog';
import { providerKey } from './auth';
import { HttpError } from './http';
import { decodeAttempt, getAttempt, history, type AttemptRow } from './store';
import { VerdictStream } from './verdict';

export function reportedUsage(raw: unknown): Usage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u: Usage = {};
  for (const field of ['prompt_tokens','completion_tokens','total_tokens','cost'] as const) {
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) u[field] = value;
  }
  return Object.keys(u).length ? u : null;
}
export function returnedCitations(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(a => {
    const citation = a?.type === 'url_citation' ? a.url_citation : undefined;
    const url = typeof citation?.url === 'string' ? safeUrl(citation.url) : undefined;
    return url ? [{ url, title: typeof citation.title === 'string' ? citation.title.slice(0,300) : new URL(url).hostname }] : [];
  }).slice(0,50);
}
function providerError(status: number): string {
  if (status === 402) return 'OpenRouter credits or the key budget are insufficient. Check your account, then retry.';
  if (status === 401 || status === 403) return 'OpenRouter denied this request. Reconnect your account or check server-tool access.';
  if (status === 404) return 'This exact model is unavailable. No replacement was used.';
  if (status === 429) return 'OpenRouter rate limit reached. Wait before retrying.';
  return `OpenRouter could not complete this response (${status}). Retry explicitly.`;
}
type Chunk = {
  id?: string; error?: { code?: number }; usage?: unknown; annotations?: unknown;
  choices?: { error?: { code?: number }; finish_reason?: string | null; delta?: { content?: string; annotations?: unknown }; message?: { annotations?: unknown } }[];
};
export async function streamAttempt(request: Request, env: AppEnv, ctx: ExecutionContext, owner: string, id: string): Promise<Response> {
  const a = await getAttempt(env, owner, id);
  if (a.status !== 'pending') throw new HttpError(409, 'This attempt has already started. Reload its saved response; use Retry to run again.');
  const key = await providerKey(env, owner);
  const { models } = await catalog(env); const model = models.find(m => m.id === a.model_id);
  if (!model) {
    await env.DB.prepare("UPDATE attempts SET status='error',error=?,finished_at=? WHERE id=? AND status='pending'").bind('This exact model is unavailable. No replacement was used.', Date.now(), id).run();
    throw new HttpError(409, 'This exact model is unavailable. No replacement was used.');
  }
  const turn = await env.DB.prepare('SELECT search FROM turns WHERE id=? AND owner_id=?').bind(a.turn_id, owner).first<{ search: number }>();
  const decision = new VerdictStream();
  const payload = { ...parameters(model, !!turn?.search), messages: [{ role: 'system', content: decision.instruction() }, ...await history(env, a)] };
  const start = Date.now();
  const claim = await env.DB.prepare("UPDATE attempts SET status='running',started_at=?,lease_until=? WHERE id=? AND owner_id=? AND status='pending' AND cancel_requested=0 RETURNING id").bind(start, start + LEASE_MS, id, owner).first();
  if (!claim) throw new HttpError(409, 'This attempt was already claimed or stopped.');
  const abort = new AbortController(); let closed = false; let task: Promise<void>;
  const abortForDisconnect = () => abort.abort('disconnected');
  request.signal.addEventListener('abort', abortForDisconnect, { once: true });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      task = run(env, { ...a, started_at: start }, key, payload, decision, abort, data => {
        if (closed) return;
        if ((controller.desiredSize ?? 0) < 0) { abort.abort('slow-client'); throw new Error('Client stopped reading.'); }
        controller.enqueue(sse(data));
      }).catch(() => { /* Saved leases recover if D1 itself is unavailable. */ }).finally(() => {
        closed = true; request.signal.removeEventListener('abort', abortForDisconnect);
        try { controller.close(); } catch { /* client disconnected */ }
      });
      ctx.waitUntil(task);
    },
    cancel() { closed = true; abort.abort('disconnected'); return task; },
  }, { highWaterMark: 262_144, size: chunk => chunk.byteLength });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' } });
}
async function run(env: AppEnv, a: AttemptRow, key: string, payload: unknown, decision: VerdictStream, abort: AbortController, emit: (data: unknown) => void) {
  let text = ''; let citations: Citation[] = []; let usage: Usage | null = null; let providerId: string | null = null;
  let status: 'complete' | 'stopped' | 'error' | 'interrupted' = 'interrupted'; let error: string | null = null;
  let verdict: Verdict | null = null;
  let checkpointTask: Promise<void> | null = null;
  const checkpoint = async () => {
    const updated = await env.DB.prepare("UPDATE attempts SET text=?,citations=?,usage=?,provider_id=?,lease_until=? WHERE id=? AND status='running' RETURNING cancel_requested")
      .bind(text, JSON.stringify(citations), usage ? JSON.stringify(usage) : null, providerId, Date.now() + LEASE_MS, a.id).first<{ cancel_requested: number }>();
    if (!updated || updated.cancel_requested) abort.abort('stopped');
  };
  const timer = setInterval(() => {
    if (checkpointTask) return;
    checkpointTask = checkpoint().then(() => { emit({ type: 'heartbeat' }); }).catch(() => abort.abort('storage')).finally(() => { checkpointTask = null; });
  }, 2000);
  const deadline = setTimeout(() => abort.abort('timeout'), MAX_STREAM_MS);
  try {
    emit({ type: 'started', id: a.id, started_at: a.started_at });
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': env.APP_ORIGIN || 'https://council-delta-nine.vercel.app', 'X-OpenRouter-Title': 'Council' },
      body: JSON.stringify(payload), signal: abort.signal,
    });
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status, providerError(response.status)); }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Invalid provider stream.');
    let done = false;
    for await (const data of readSSE(response.body)) {
      if (abort.signal.aborted) throw new Error('Aborted.');
      if (data === '[DONE]') { done = true; break; }
      const chunk = JSON.parse(data) as Chunk; const choice = chunk.choices?.[0];
      if (chunk.error || choice?.error || choice?.finish_reason === 'error') throw new HttpError(Number(chunk.error?.code || choice?.error?.code || 502), providerError(Number(chunk.error?.code || choice?.error?.code || 502)));
      if (typeof chunk.id === 'string') providerId = chunk.id.slice(0,200);
      const delta = choice?.delta?.content;
      if (typeof delta === 'string') {
        const visible = decision.push(delta);
        text += visible;
        if (text.length > 500_000) throw new HttpError(413, 'Response exceeded the saved-text limit. The partial answer was retained.');
        if (visible) emit({ type: 'delta', text: visible });
      }
      const received = returnedCitations(chunk.annotations).concat(returnedCitations(choice?.delta?.annotations), returnedCitations(choice?.message?.annotations));
      if (received.length) { citations = [...new Map([...citations, ...received].map(c => [c.url, c])).values()].slice(0,50); emit({ type: 'citations', citations }); }
      const reported = reportedUsage(chunk.usage); if (reported) { usage = Object.assign({}, usage, reported); emit({ type: 'usage', usage }); }
      // finish_reason does not end the stream: final usage may follow separately.
    }
    if (!done) throw new Error('Stream ended without a terminator.');
    verdict = decision.finish();
    if (!text.trim()) throw new HttpError(502, 'The model returned no answer. Please retry.');
    status = 'complete';
  } catch (failure) {
    if (abort.signal.aborted) {
      status = abort.signal.reason === 'stopped' ? 'stopped' : 'interrupted';
      error = status === 'stopped' ? null : abort.signal.reason === 'timeout' ? 'Response reached the time limit. Partial answer saved; retry explicitly.' : 'Connection interrupted. Partial answer saved; retry explicitly.';
    } else { status = failure instanceof HttpError ? 'error' : 'interrupted'; error = failure instanceof HttpError ? failure.message : 'Provider stream interrupted. Partial answer saved; retry explicitly.'; }
  } finally {
    clearInterval(timer); clearTimeout(deadline); if (checkpointTask) await checkpointTask;
    text = (text + decision.drain()).trimEnd();
    const saved = await env.DB.prepare("UPDATE attempts SET text=?,citations=?,usage=?,provider_id=?,status=CASE WHEN cancel_requested=1 THEN 'stopped' ELSE ? END,error=CASE WHEN cancel_requested=1 THEN NULL ELSE ? END,verdict=CASE WHEN cancel_requested=1 THEN NULL ELSE ? END,finished_at=?,lease_until=NULL WHERE id=? AND status='running' RETURNING *")
      .bind(text.slice(0,500_000), JSON.stringify(citations), usage ? JSON.stringify(usage) : null, providerId, status, error, status === 'complete' ? verdict : null, Date.now(), a.id).first<AttemptRow>();
    if (saved) { try { emit({ type: 'finished', attempt: decodeAttempt(saved) }); } catch { /* saved even after disconnect */ } }
  }
}
