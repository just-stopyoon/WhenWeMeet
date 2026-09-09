const upstreamOrigin = 'https://when-we-meet-yangpa.stopjung1025.chatgpt.site';

export async function proxy(request) {
  const incoming = new URL(request.url);
  const path = incoming.searchParams.get('path') ?? incoming.pathname.replace(/^\//, '');
  const upstream = new URL(upstreamOrigin);
  upstream.pathname = '/' + path.replace(/^\/+/, '');
  incoming.searchParams.delete('path');
  upstream.search = incoming.searchParams.toString();
  if (!(upstream.pathname === '/' || upstream.pathname === '/api/meeting' || upstream.pathname === '/favicon.svg' || upstream.pathname.startsWith('/assets/') || upstream.pathname.startsWith('/_next/static/'))) {
    return new Response('Not found', { status: 404 });
  }
  if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD, POST' } });
  }
  if (request.method === 'POST' && (upstream.pathname !== '/api/meeting' || request.headers.get('origin') !== incoming.origin)) {
    return new Response('Forbidden', { status: 403 });
  }
  const headers = new Headers();
  for (const name of ['accept', 'content-type', 'rsc', 'next-router-state-tree', 'next-router-prefetch', 'next-url']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Forward only the app session, never Vercel authentication or unrelated cookies.
  const session = request.headers.get('cookie')?.split(';').map(c => c.trim()).find(c => c.startsWith('wwm_session='));
  if (session) headers.set('cookie', session);
  if (request.method === 'POST') headers.set('origin', upstreamOrigin);
  let body;
  if (request.method === 'POST') {
    body = await request.text();
    if (body.length > 20000) return new Response('Request too large', { status: 413 });
  }
  try {
    const response = await fetch(upstream, { method: request.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(25000) });
    if (response.status >= 300 && response.status < 400) return new Response('Upstream unavailable', { status: 502 });
    const outgoing = new Headers({
      'Content-Type': response.headers.get('content-type') || 'application/octet-stream',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    for (const cookie of response.headers.getSetCookie()) {
      if (cookie.startsWith('wwm_session=')) outgoing.append('Set-Cookie', cookie);
    }
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers: outgoing });
  } catch {
    return Response.json({ error: '서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
