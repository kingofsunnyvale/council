export default {
  async fetch(request, env) {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    const { pathname } = new URL(request.url);
    if (pathname !== '/health') {
      return Response.json({ error: 'not_found' }, { status: 404, headers });
    }
    if (request.method !== 'GET') {
      return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { ...headers, Allow: 'GET' } });
    }
    try {
      const result = await env.DB.prepare('SELECT 1 AS ok').first();
      if (result?.ok !== 1) throw new Error('Database health check failed');
      return Response.json({ service: 'council', status: 'ok', database: 'connected' }, { headers });
    } catch {
      return Response.json({ service: 'council', status: 'unavailable' }, { status: 503, headers });
    }
  },
};
