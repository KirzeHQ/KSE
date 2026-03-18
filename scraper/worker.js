async function sha256hex(input) {
  try {
    if (globalThis.crypto && globalThis.crypto.subtle && typeof globalThis.crypto.subtle.digest === 'function') {
      const buf = typeof input === 'string' ? new TextEncoder().encode(input) : input;
      const hash = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (e) {}
  try {
    const nodeCrypto = await import('crypto');
    return nodeCrypto.createHash('sha256').update(typeof input === 'string' ? input : Buffer.from(input)).digest('hex');
  } catch (e) {
    return '';
  }
}

function normalizeUrl(href, base) {
  try {
    return new URL(href, base).toString();
  } catch (e) {
    return null;
  }
}

function extractLinks(html, base) {
  const re = /href\s*=\s*"([^"]+)"/gi;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const h = m[1].trim();
    if (!h) continue;
    if (h.startsWith('mailto:') || h.startsWith('javascript:') || h.startsWith('tel:') || h.startsWith('data:')) continue;
    const n = normalizeUrl(h, base);
    if (n && (n.startsWith('http://') || n.startsWith('https://'))) out.push(n);
  }
  return Array.from(new Set(out));
}

function extractTitle(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim() : '';
}

function extractMetaDescription(html) {
  const m = html.match(/<meta\s+name=["']description["']\s+content=["']([\s\S]*?)["']\s*\/?\>/i) || html.match(/<meta\s+content=["']([\s\S]*?)["']\s+name=["']description["']\s*\/?\>/i);
  return m ? m[1].trim() : '';
}

function extractCanonical(html, base) {
  const m = html.match(/<link\s+rel=["']canonical["']\s+href=["']([\s\S]*?)["']\s*\/?\>/i);
  if (m) return normalizeUrl(m[1], base);
  return null;
}

function extractLang(html) {
  const m = html.match(/<html[^>]*lang=["']?([^"'>\s]+)["']?/i);
  return m ? m[1].toLowerCase() : '';
}

self.onmessage = async (e) => {
  const { taskId, url } = e.data;
  try {
    const res = await fetch(url, { method: 'GET', keepalive: true });
    const status = res.status;
    const html = await res.text();
    const title = extractTitle(html);
    const description = extractMetaDescription(html) || '';
    const canonical = extractCanonical(html, url) || url;
    const lang = extractLang(html) || (res.headers.get && (res.headers.get('content-language') || '').split(',')[0]) || '';
    const links = extractLinks(html, url).slice(0, 200);
    const content_hash = await sha256hex(html);

    self.postMessage({ taskId, result: { url, status, html, title, description, canonical, lang, links, content_hash } });
  } catch (err) {
    self.postMessage({ taskId, error: String(err) });
  }
};

export {};
