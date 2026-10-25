import { MAX_COMPLETION, REQUESTED_MODELS, SEARCH, type Model } from '../shared/config';
import type { AppEnv } from './env';
import { HttpError, readJson } from './http';

export async function catalog(env: AppEnv): Promise<{ models: Model[]; fetchedAt: number }> {
  const cached = await env.DB.prepare('SELECT data,fetched_at FROM catalog_cache WHERE id=1').first<{ data: string; fetched_at: number }>();
  if (cached && Date.now() - cached.fetched_at < 300_000) return { models: JSON.parse(cached.data), fetchedAt: cached.fetched_at };
  const response = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) { await response.body?.cancel(); throw new HttpError(503, 'The live model catalog is unavailable. Try again.'); }
  const data = await readJson<{ data: (Model & { architecture?: { input_modalities?: string[]; output_modalities?: string[] } })[] }>(response, 12_000_000);
  if (!Array.isArray(data.data)) throw new HttpError(503, 'The model catalog was invalid.');
  const models = data.data.filter(m => m.architecture?.input_modalities?.includes('text') && m.architecture?.output_modalities?.includes('text') && m.id !== 'openrouter/auto').map(m => ({
    id: m.id, name: m.name, context_length: m.context_length, top_provider: { max_completion_tokens: m.top_provider?.max_completion_tokens ?? null },
    supported_parameters: m.supported_parameters || [], pricing: m.pricing, reasoning: m.reasoning,
  }));
  const fetchedAt = Date.now();
  await env.DB.prepare('INSERT INTO catalog_cache(id,data,fetched_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at').bind(JSON.stringify(models), fetchedAt).run();
  return { models, fetchedAt };
}
export function validateModels(ids: unknown, models: Model[]): asserts ids is string[] {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 8 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !models.some(m => m.id === id))) throw new HttpError(400, 'Choose one to eight distinct models from the live catalog.');
}
export function parameters(model: Model, search: boolean) {
  const supportsCap = model.supported_parameters.includes('max_tokens') || model.supported_parameters.includes('max_completion_tokens');
  if (!supportsCap) throw new HttpError(400, `${model.name} does not advertise a completion limit. Choose another model.`);
  const cap = Math.min(MAX_COMPLETION, model.top_provider.max_completion_tokens || MAX_COMPLETION, model.context_length);
  const high = model.reasoning?.supported_efforts?.includes('high') && model.supported_parameters.includes('reasoning');
  return {
    model: model.id, stream: true, stream_options: { include_usage: true },
    [model.supported_parameters.includes('max_tokens') ? 'max_tokens' : 'max_completion_tokens']: cap,
    ...(high ? { reasoning: { effort: 'high', exclude: true } } : model.supported_parameters.includes('reasoning') ? { reasoning: { enabled: true, exclude: true } } : {}),
    // Mixed lineups remain usable: the UI discloses which models cannot search.
    ...(search && model.supported_parameters.includes('tools') ? { tools: [SEARCH] } : {}),
    provider: { require_parameters: true, allow_fallbacks: false },
  };
}
export const missingRequested = (models: Model[]) => REQUESTED_MODELS.filter(m => !models.some(x => x.id === m.id));
