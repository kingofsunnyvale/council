export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function api<T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch('/api' + path, { credentials: 'same-origin', ...options, body: options?.body === undefined ? undefined : JSON.stringify(options.body), headers: { 'Content-Type': 'application/json' } });
  const data = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new ApiError(data.error || `Request failed (${response.status}).`, response.status);
  return data as T;
}
