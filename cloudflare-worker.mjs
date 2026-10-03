const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function brandedWakePage(path) {
  const safePath = JSON.stringify(path).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Isolde is opening</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f3ed;color:#211e1a;font:16px Arial,sans-serif}.card{text-align:center;padding:32px;max-width:420px}.brand{font:44px Georgia,serif;letter-spacing:.08em}.spinner{width:28px;height:28px;margin:28px auto;border:3px solid #ded6ca;border-top-color:#85694b;border-radius:50%;animation:spin .8s linear infinite}p{color:#70675c;line-height:1.6}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><main class="card"><div class="brand">ISOLDE</div><div class="spinner" aria-label="Loading"></div><p>Opening our fragrance collection. This page will refresh automatically.</p></main><script>setTimeout(()=>location.replace(${safePath}),6000)</script></body></html>`;
}

function isRenderWakePage(response, body) {
  if (!response.headers.get('content-type')?.includes('text/html')) return false;
  const text = body.slice(0, 16000).toLowerCase();
  return text.includes('render') && (text.includes('spin') || text.includes('wake') || text.includes('starting') || text.includes('deploy'));
}

export async function proxy(request, env, fetchImpl = fetch) {
  let origin;
  try { origin = new URL(env.ORIGIN_URL); }
  catch { return new Response('Cloudflare proxy is missing a valid ORIGIN_URL.', { status: 500 }); }
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.onrender.com')) {
    return new Response('ORIGIN_URL must be the HTTPS URL of this Render web service.', { status: 500 });
  }

  const incoming = new URL(request.url);
  origin.pathname = incoming.pathname;
  origin.search = incoming.search;
  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  headers.set('x-forwarded-host', incoming.host);
  headers.set('x-forwarded-proto', 'https');

  let upstream;
  try {
    upstream = await fetchImpl(new Request(origin, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
      duplex: 'half',
    }));
  } catch {
    if (!['GET', 'HEAD'].includes(request.method) || !request.headers.get('accept')?.includes('text/html')) {
      return new Response('The store is waking up. Please retry shortly.', { status: 503, headers: { 'retry-after': '6' } });
    }
    return new Response(brandedWakePage(incoming.pathname + incoming.search), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    const candidate = upstream.clone();
    const body = await candidate.text().catch(() => '');
    if (isRenderWakePage(upstream, body)) {
      return new Response(brandedWakePage(incoming.pathname + incoming.search), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
  }

  const responseHeaders = new Headers(upstream.headers);
  for (const name of HOP_BY_HOP) responseHeaders.delete(name);
  responseHeaders.delete('content-length');
  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export default { fetch: proxy };
