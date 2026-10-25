export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
}
export function redirect(location: string, cookie?: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
}
export async function boundedText(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!body) return '';
  const reader = body.getReader(); const decoder = new TextDecoder(); let bytes = 0; let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new HttpError(413, 'Request or response is too large.'); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}
export async function readJson<T>(request: Request | Response, limit = 100_000): Promise<T> {
  if (request instanceof Request && !request.headers.get('content-type')?.includes('application/json')) throw new HttpError(415, 'Expected application/json.');
  const text = await boundedText(request.body, limit);
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}
export const validKey = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,100}$/.test(value);
