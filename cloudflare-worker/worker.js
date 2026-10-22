/**
 * Smart Indexer Pro - Cloudflare Worker bridge
 *
 * Bindings (see wrangler.toml / README):
 *   LINKS_KV  - KV namespace that stores slug -> { targetUrl, mode, createdAt }
 *   API_KEY   - secret (wrangler secret put API_KEY), sent by the app as the X-API-KEY header
 *
 * Routes:
 *   POST   /api/create        { slug, targetUrl, mode }  (X-API-KEY required)
 *   GET    /api/health        connectivity check          (X-API-KEY required)
 *   GET    /api/link/:slug    read a stored link          (X-API-KEY required)
 *   DELETE /api/link/:slug    remove a stored link        (X-API-KEY required)
 *   GET    /:slug             public bridge: 301 redirect or HTML bridge page
 */

const SLUG_RE = /^[a-zA-Z0-9_-]{3,64}$/;
const MODES = ['301_REDIRECT', '302_REDIRECT', 'HTML_BRIDGE'];
const RESERVED = new Set(['api', 'robots.txt', 'favicon.ico']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return text('Method not allowed', 405);
    }
    if (url.pathname === '/') return text('OK', 200, { 'X-Robots-Tag': 'noindex' });
    if (url.pathname === '/robots.txt') return text('User-agent: *\nAllow: /\n');
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });

    let slug;
    try {
      slug = decodeURIComponent(url.pathname.slice(1)).replace(/\/+$/, '');
    } catch {
      return notFound();
    }
    if (!SLUG_RE.test(slug)) return notFound();

    const record = await env.LINKS_KV.get(slug, 'json');
    if (!record || !isHttpUrl(record.targetUrl)) return notFound();

    if (record.mode === 'HTML_BRIDGE') return htmlBridge(record.targetUrl, url);

    return new Response(null, {
      status: record.mode === '302_REDIRECT' ? 302 : 301,
      headers: { Location: record.targetUrl, 'Cache-Control': 'public, max-age=3600' },
    });
  },
};

/* ------------------------------- admin API ------------------------------- */

async function handleApi(request, env, url) {
  if (!env.API_KEY) return json({ error: 'API_KEY secret is not configured on the Worker' }, 500);
  if (!(await safeEqual(request.headers.get('X-API-KEY') || '', env.API_KEY))) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const path = url.pathname.replace(/\/+$/, '');

  if (path === '/api/health' && request.method === 'GET') {
    return json({ ok: true, kv: Boolean(env.LINKS_KV), time: new Date().toISOString() });
  }

  if (path === '/api/create' && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Body must be JSON' }, 400);
    }
    const slug = String(body.slug || '');
    const targetUrl = String(body.targetUrl || '');
    const mode = MODES.includes(body.mode) ? body.mode : 'HTML_BRIDGE';

    if (!SLUG_RE.test(slug) || RESERVED.has(slug.toLowerCase())) {
      return json({ error: 'slug must be 3-64 chars of a-z, 0-9, _ or -' }, 400);
    }
    if (!isHttpUrl(targetUrl)) return json({ error: 'targetUrl must be an http(s) URL' }, 400);

    await env.LINKS_KV.put(slug, JSON.stringify({ targetUrl, mode, createdAt: new Date().toISOString() }));
    return json({ ok: true, slug, mode, url: `${url.origin}/${slug}` }, 201);
  }

  const match = path.match(/^\/api\/link\/([^/]+)$/);
  if (match) {
    const slug = decodeURIComponent(match[1]);
    if (request.method === 'GET') {
      const record = await env.LINKS_KV.get(slug, 'json');
      return record ? json({ slug, ...record }) : json({ error: 'Not found' }, 404);
    }
    if (request.method === 'DELETE') {
      await env.LINKS_KV.delete(slug);
      return json({ ok: true });
    }
  }

  return json({ error: 'Not found' }, 404);
}

/* -------------------------------- helpers -------------------------------- */

function htmlBridge(targetUrl, requestUrl) {
  const target = new URL(targetUrl);
  const host = target.hostname.replace(/^www\./, '');
  const pathLabel = decodeURIComponent(target.pathname).replace(/[-_/]+/g, ' ').trim();
  const title = pathLabel ? `${pathLabel} - ${host}` : host;
  const t = escapeHtml(targetUrl);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="Continue to ${escapeHtml(host)}: ${escapeHtml(title)}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${escapeHtml(requestUrl.origin + requestUrl.pathname)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:url" content="${t}">
<meta http-equiv="refresh" content="3;url=${t}">
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:15vh auto;padding:0 20px;color:#1f2937;line-height:1.6}
a{color:#4f46e5;word-break:break-all}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>This resource is hosted on <strong>${escapeHtml(host)}</strong>. You will be taken there in a few seconds.</p>
<p>Visit the page: <a href="${t}" rel="dofollow">${t}</a></p>
</main>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
  });
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Compares SHA-256 digests so the comparison time does not depend on where the strings differ.
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function text(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });
}

function notFound() {
  return text('Not found', 404, { 'X-Robots-Tag': 'noindex' });
}
