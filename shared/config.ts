export const PUBLIC_ORIGIN = 'https://council-delta-nine.vercel.app';
export const WORKER_ORIGIN = 'https://council-api.anywager.workers.dev';
export const REQUESTED_MODELS = [
  { id: 'openai/gpt-6-astra', name: 'GPT-6 Astra', provider: 'OpenAI', color: '#a5d8c2' },
  { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5', provider: 'Anthropic', color: '#e8b097' },
  { id: 'google/gemini-4-argon', name: 'Gemini 4 Argon', provider: 'Google', color: '#9ebcfa' },
  { id: 'x-ai/grok-4.7', name: 'Grok 4.7', provider: 'xAI', color: '#dedee8' },
  { id: 'moonshotai/kimi-k3.1-pro', name: 'Kimi K3.1 Pro', provider: 'Moonshot', color: '#b9adf7' },
  { id: 'z-ai/glm-5.3', name: 'GLM 5.3', provider: 'Z.ai', color: '#edcc82' },
  { id: 'mistralai/mistral-large-4-0', name: 'Mistral Large 4', provider: 'Mistral', color: '#edab78' },
] as const;
export const SEARCH = { type: 'openrouter:web_search', parameters: { engine: 'exa', mode: 'auto', max_uses: 3, max_results: 5, max_total_results: 15 } };
export const SEARCH_DOCS = 'https://openrouter.ai/docs/guides/features/server-tools/web-search';
export const MAX_COMPLETION = 32_768;
export const LEASE_MS = 30_000;
export const MAX_STREAM_MS = 270_000;
export const MAX_PROMPT = 24_000;

export type Model = {
  id: string; name: string; context_length: number;
  top_provider: { max_completion_tokens: number | null };
  supported_parameters: string[];
  pricing: Record<string, unknown> & { prompt?: string; completion?: string };
  reasoning?: { supported_efforts?: string[]; mandatory?: boolean; default_effort?: string };
};
export type Citation = { url: string; title: string };
export type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
export type Attempt = {
  id: string; turn_id: string; conversation_id: string; model_id: string; number: number;
  status: 'pending' | 'running' | 'complete' | 'stopped' | 'interrupted' | 'error';
  text: string; citations: Citation[]; usage: Usage | null; error: string | null;
  started_at: number | null; finished_at: number | null; created_at: number; provider_id: string | null;
};
export type Turn = { id: string; sequence: number; prompt: string; search: number; created_at: number };
export type Conversation = { id: string; title: string; models: string[]; version: number; created_at: number; updated_at: number };
export type ConversationDetail = { conversation: Conversation; turns: Turn[]; attempts: Attempt[] };
export const active = (a: Pick<Attempt, 'status'>) => a.status === 'pending' || a.status === 'running';
export function safeUrl(value: string): string | undefined {
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : undefined; } catch { return undefined; }
}
