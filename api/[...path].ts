import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PUBLIC_ORIGIN, WORKER_ORIGIN } from '../shared/config.js';

export const config = { maxDuration: 300 };
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const secret = process.env.SERVICE_SECRET;
  const path = new URL(req.url || '/', PUBLIC_ORIGIN);
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
  if (!secret || !path.pathname.startsWith('/api/')) { res.statusCode = 503; res.end(JSON.stringify({ error: 'Application gateway is awaiting configuration.' })); return; }
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });
  try {
    const buffers: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      const b = Buffer.from(chunk); size += b.length;
      if (size > 100_000) { res.statusCode = 413; res.end(JSON.stringify({ error: 'Request too large.' })); return; }
      buffers.push(b);
    }
    const headers = new Headers({ 'x-council-service': secret });
    // Build the forwarded headers from an allowlist; never forward caller identity or service headers.
    for (const name of ['cookie','origin','content-type']) {
      const value = req.headers[name]; if (typeof value === 'string') headers.set(name, value);
    }
    const response = await fetch(WORKER_ORIGIN + path.pathname + path.search, {
      method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(buffers),
      redirect: 'manual', signal: abort.signal,
    });
    res.statusCode = response.status;
    for (const name of ['content-type','cache-control','x-content-type-options','referrer-policy','x-accel-buffering']) {
      const value = response.headers.get(name); if (value) res.setHeader(name, value);
    }
    const location = response.headers.get('location');
    if (location && new URL(location).origin === PUBLIC_ORIGIN) res.setHeader('Location', location);
    const cookies = response.headers.getSetCookie(); if (cookies.length) res.setHeader('Set-Cookie', cookies);
    if (!response.body) { res.end(); return; }
    res.flushHeaders();
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), res);
  } catch {
    if (!res.headersSent) { res.statusCode = 502; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ error: 'Application service is temporarily unavailable.' })); }
    else res.destroy();
  }
}
