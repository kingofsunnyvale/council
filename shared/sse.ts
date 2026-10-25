// SSE framing is independent of TCP chunks, UTF-8 boundaries, and CRLF splits.
export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader(); const decoder = new TextDecoder();
  let buffer = ''; let data: string[] = []; let frameLength = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length + frameLength > 524_288) throw new Error('Stream frame is too large.');
      let position: number;
      while ((position = buffer.search(/[\r\n]/)) >= 0) {
        if (!done && position === buffer.length - 1 && buffer[position] === '\r') break;
        const line = buffer.slice(0, position);
        buffer = buffer.slice(position + (buffer[position] === '\r' && buffer[position + 1] === '\n' ? 2 : 1));
        if (line === '') { if (data.length) yield data.join('\n'); data = []; frameLength = 0; }
        else if (line === 'data' || line.startsWith('data:')) {
          const content = line === 'data' ? '' : line.slice(5).replace(/^ /, '');
          data.push(content); frameLength += content.length;
        }
      }
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function sse(data: unknown): Uint8Array { return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`); }
