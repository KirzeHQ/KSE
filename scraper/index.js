import fs from 'fs/promises';

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8080';
const STATE_FILE = new URL('./.scraper.json', import.meta.url).pathname;
const SCRAPED_FILE = new URL('./scraped.json', import.meta.url).pathname;

const DEFAULT_SEEDS = ['https://www.wikipedia.org'];
const DEFAULT_MAX_PAGES = 200;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_CONTINUOUS = true;
const DEFAULT_POLL_INTERVAL = 600;
const DEFAULT_REVISIT_AFTER = 24 * 3600;

async function loadState() {
  try {
    const s = await fs.readFile(STATE_FILE, 'utf8');
    return JSON.parse(s);
  } catch (e) {
    return {};
  }
}

async function saveState(st) {
  await fs.writeFile(STATE_FILE, JSON.stringify(st, null, 2), 'utf8');
}

async function saveScraped(visited) {
  try {
    const arr = Object.keys(visited || {});
    await fs.writeFile(SCRAPED_FILE, JSON.stringify({ scraped: arr }, null, 2), 'utf8');
  } catch (e) {
  }
}

async function registerApi(name = 'scraper-test') {
  const res = await fetch(`${API_BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`register API failed: ${res.status}`);
  const j = await res.json();
  return j.api_key;
}

async function registerScraper(apiKey, name = 'local-scraper') {
  const res = await fetch(`${API_BASE}/scraper/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`scraper register failed: ${res.status} ${txt}`);
  }
  const j = await res.json();
  return j.id;
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
  const m = html.match(/<meta\s+name=["']description["']\s+content=["']([\s\S]*?)["']\s*\/?>/i) || html.match(/<meta\s+content=["']([\s\S]*?)["']\s+name=["']description["']\s*\/?>/i);
  return m ? m[1].trim() : '';
}

function extractMeta(html, name) {
  const re1 = new RegExp(`<meta\\s+name=["']${name}["']\\s+content=["']([\\s\\S]*?)["']\\s*\\/?\\>`, 'i');
  const re2 = new RegExp(`<meta\\s+content=["']([\\s\\S]*?)["']\\s+name=["']${name}["']\\s*\\/?\\>`, 'i');
  const m = html.match(re1) || html.match(re2);
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

function extractH1(html) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
}

function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

async function sha256hex(input) {
  try {
    if (globalThis.crypto && globalThis.crypto.subtle && typeof globalThis.crypto.subtle.digest === 'function') {
      const buf = typeof input === 'string' ? new TextEncoder().encode(input) : input;
      const hash = await crypto.subtle.digest('SHA-256', buf);
      const a = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
      return a;
    }
  } catch (e) {
  }
  try {
    const nodeCrypto = await import('crypto');
    return nodeCrypto.createHash('sha256').update(typeof input === 'string' ? input : Buffer.from(input)).digest('hex');
  } catch (e) {
    return '';
  }
}

function extractTextSnippet(html, max = 400) {
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const s = text.replace(/\s+/g, ' ').trim();
  return s.slice(0, max);
}

async function submit(apiKey, scraperId, source = 'crawler', payload = null) {
  const url = new URL(`${API_BASE}/submit`);
  url.searchParams.set('source', source);
  url.searchParams.set('scraper_id', scraperId);

  const body = payload ?? JSON.stringify({ ts: Date.now(), message: 'crawler payload' });

  const res = await fetch(url.toString(), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${apiKey}`, 'X-Scraper-Id': scraperId, 'content-type': 'application/json' },
    body,
  });
  const txt = await res.text();
  return { ok: res.ok, status: res.status, body: txt };
}

async function crawlLoop(apiKey, scraperId, state, opts) {
  const seeds = opts.seeds || DEFAULT_SEEDS;
  const max_pages = opts.max_pages || DEFAULT_MAX_PAGES;
  const max_depth = opts.max_depth || DEFAULT_MAX_DEPTH;
  const concurrency = opts.concurrency || DEFAULT_CONCURRENCY;

  if (state.seeds && (!state.config || !state.config.seeds || state.config.seeds.length === 0)) {
    state.config = state.config || {};
    state.config.seeds = state.seeds;
    delete state.seeds;
  }

  state.frontier = state.frontier || [];
  state.visited = state.visited || {};

  const frontierHasSeed = state.frontier.some((f) => seeds.includes(f.url));
  if (state.frontier.length === 0 || !frontierHasSeed) {
    state.frontier = [];
    for (const s of seeds) state.frontier.push({ url: s, depth: 0 });
  }

  let processed = 0;

  const ram_limit_mb = (opts.ram_limit_mb || process.env.RAM_LIMIT_MB) ? Number(opts.ram_limit_mb || process.env.RAM_LIMIT_MB) : null;
  const cpu_ops_per_sec = (opts.cpu_ops_per_sec || process.env.CPU_OPS_PER_SEC) ? Number(opts.cpu_ops_per_sec || process.env.CPU_OPS_PER_SEC) : null;
  const per_request_delay_ms = cpu_ops_per_sec && cpu_ops_per_sec > 0 ? Math.round(1000 / cpu_ops_per_sec) : 0;

  while (state.frontier.length > 0 && processed < max_pages) {
    const batch = [];
    while (batch.length < concurrency && state.frontier.length > 0 && processed + batch.length < max_pages) {
      const item = state.frontier.shift();
      if (!item) break;
      const last = state.visited[item.url] || 0;
      const now = Date.now();
      if (last && (now - last) < (opts.revisit_after_seconds || DEFAULT_REVISIT_AFTER) * 1000) continue;
      state.visited[item.url] = now;
      batch.push(item);
    }

    if (batch.length === 0) break;

    await Promise.all(batch.map(async (it) => {
      try {
        if (ram_limit_mb) {
          const usageMb = (process.memoryUsage().rss || 0) / (1024 * 1024);
          if (usageMb > ram_limit_mb) {
            console.warn('Memory usage', Math.round(usageMb), 'MB exceeds limit', ram_limit_mb, 'MB — sleeping');
            await new Promise((r) => setTimeout(r, 5000));
          }
        }

        const res = await fetch(it.url, { method: 'GET' });
        const status = res.status;
        const ct = res.headers.get('content-type') || '';
        const html = await res.text();

        const title = extractTitle(html);
        const description = extractMetaDescription(html) || extractMeta(html, 'Description') || '';
        const canonical = extractCanonical(html, it.url);
        const lang = extractLang(html) || (res.headers.get('content-language') || '').split(',')[0];
        const h1 = extractH1(html);
        const snippet = extractTextSnippet(html, 800);
        const plain_text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const word_count = countWords(plain_text);
        const links = extractLinks(html, it.url).slice(0, 200);
        const meta_keywords = extractMeta(html, 'keywords') || '';
        const meta_robots = extractMeta(html, 'robots') || '';

        const u = new URL(it.url);
        const host = u.hostname;

        const content_hash = await sha256hex(html);
        const payload = {
          url: it.url,
          title,
          canonical: canonical || it.url,
          outlinks_count: links.length,
          lang,
          description,
          status,
          fetches: 1,
          content_hash,
        };

        const r = await submit(apiKey, scraperId, host, JSON.stringify(payload));
        console.log('Submitting', it.url, '->', r.status, r.ok, r.body);

        if (per_request_delay_ms > 0) await new Promise((r) => setTimeout(r, per_request_delay_ms));

        if (it.depth + 1 <= max_depth) {
          for (const l of links) {
            const last = state.visited[l] || 0;
            const now = Date.now();
            if (!last || (now - last) >= (opts.revisit_after_seconds || DEFAULT_REVISIT_AFTER) * 1000) {
              state.frontier.push({ url: l, depth: it.depth + 1 });
            }
          }
        }
      } catch (e) {
        console.error('fetch error', it.url, e.message || e);
      } finally {
        processed += 1;
      }
    }));

    await saveState(state);
    await saveScraped(state.visited);
  }
}

async function main() {
  const state = await loadState();
  let apiKey = state.api_key;
  let scraperId = state.scraper_id;

  try {
    if (state.seeds && (!state.config || !state.config.seeds || state.config.seeds.length === 0)) {
      state.config = state.config || {};
      state.config.seeds = state.seeds;
      delete state.seeds;
      await saveState(state);
    }

    if (!apiKey) {
      console.log('Registering API key...');
      apiKey = await registerApi('kse-scraper-crawler');
      state.api_key = apiKey;
      await saveState(state);
      console.log('Got api_key');
    }

    if (!scraperId) {
      console.log('Registering scraper...');
      scraperId = await registerScraper(apiKey, 'bun-crawler');
      state.scraper_id = scraperId;
      await saveState(state);
      console.log('Got scraper id');
    }

    state.config = state.config || {};
    if (!state.config.seeds || state.config.seeds.length === 0) state.config.seeds = DEFAULT_SEEDS;
    state.config.max_pages = state.config.max_pages || DEFAULT_MAX_PAGES;
    state.config.max_depth = state.config.max_depth || DEFAULT_MAX_DEPTH;
    state.config.concurrency = state.config.concurrency || DEFAULT_CONCURRENCY;
    state.config.continuous = typeof state.config.continuous === 'boolean' ? state.config.continuous : DEFAULT_CONTINUOUS;
    state.config.poll_interval_seconds = state.config.poll_interval_seconds || DEFAULT_POLL_INTERVAL;
    state.config.revisit_after_seconds = state.config.revisit_after_seconds || DEFAULT_REVISIT_AFTER;

    if (typeof state.config.ram_limit_mb === 'undefined') {
      state.config.ram_limit_mb = null;
    }
    if (typeof state.config.cpu_ops_per_sec === 'undefined') {
      state.config.cpu_ops_per_sec = null;
    }

    await saveState(state);

    console.log('Starting crawl with config:', state.config);
    do {
      await crawlLoop(apiKey, scraperId, state, state.config);
      console.log('Crawl iteration finished');
      if (state.config.continuous) {
        const wait = (state.config.poll_interval_seconds || DEFAULT_POLL_INTERVAL) * 1000;
        console.log(`Sleeping ${wait/1000}s before next crawl`);
        await new Promise(r => setTimeout(r, wait));
      }
    } while (state.config.continuous);
    console.log('Crawl finished (continuous disabled)');
  } catch (e) {
    console.error('Error:', e);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].endsWith('index.js'))) {
  main();
}
