import fs from 'fs/promises';

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8080';
const STATE_FILE = new URL('./.scraper.json', import.meta.url).pathname;
const SCRAPED_FILE = new URL('./scraped.json', import.meta.url).pathname;
const CRAWLER_FILE = new URL('./crawler.json', import.meta.url).pathname;

const DEFAULT_SEEDS = ['https://www.wikipedia.org'];
const DEFAULT_MAX_PAGES = 200;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_CONTINUOUS = true;
const DEFAULT_POLL_INTERVAL = 600;
const DEFAULT_REVISIT_AFTER = 24 * 3600;
let DEFAULT_WORKERS = DEFAULT_CONCURRENCY;
try {
  const os = await import('os');
  DEFAULT_WORKERS = (os && os.cpus && os.cpus().length) ? os.cpus().length : DEFAULT_CONCURRENCY;
} catch (e) {
  DEFAULT_WORKERS = DEFAULT_CONCURRENCY;
}

let pfetch = globalThis.fetch.bind(globalThis);
try {
  if (typeof Bun !== 'undefined') {
    pfetch = (url, opts = {}) => globalThis.fetch(url, { ...(opts || {}), keepalive: true });
  } else {
    try {
      const undici = await import('undici');
      try {
        const { Agent, setGlobalDispatcher } = undici;
        const poolConnections = Number(process.env.HTTP_POOL_CONNECTIONS || 6);
        const poolPipelining = Number(process.env.HTTP_POOL_PIPELINING || 1);
        const poolKeepAliveMs = Number(process.env.HTTP_POOL_KEEPALIVE_MS || 1000);
        const agent = new Agent({ connections: poolConnections, pipelining: poolPipelining, keepAliveTimeout: poolKeepAliveMs });
        if (typeof setGlobalDispatcher === 'function') setGlobalDispatcher(agent);
      } catch (_) {
      }
      if (undici && typeof undici.fetch === 'function') {
        pfetch = undici.fetch.bind(undici);
      }
    } catch (_) {
      pfetch = globalThis.fetch.bind(globalThis);
    }
  }
} catch (e) {
  pfetch = globalThis.fetch.bind(globalThis);
}

const STATS = { fetched: 0, queued: 0, buffered: 0, full: 0, errors: 0, processed: 0, inflight: 0 };
let _progressInterval = null;
let _megaFlushInterval = null;

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};
let _progressStartTime = null;
let _barPhase = 0;
const BAR_WIDTH = 20;

function slog(...args) {
  const isTTY = Boolean(process.stdout && process.stdout.isTTY);
  if (!isTTY || !_progressInterval) {
    console.log(...args);
  }
}

function _formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function startProgressUpdate() {
  let lastProcessed = STATS.processed;
  const interval = 500;
  if (_progressInterval) return;
  if (!_progressStartTime) _progressStartTime = Date.now();
  _barPhase = 0;
  const isTTY = Boolean(process.stdout && process.stdout.isTTY);
  if (!isTTY) {
    _progressInterval = setInterval(() => {
      const nowFetched = STATS.fetched;
      const rate = ((nowFetched - lastFetched) * (1000 / 1000)).toFixed(1);
      lastFetched = nowFetched;
      console.log(`fetched:${STATS.fetched} queued:${STATS.queued} buffered:${STATS.buffered} full:${STATS.full} errors:${STATS.errors} processed:${STATS.processed} rate:${rate}/s`);
    }, 10000);
    return;
  }

  _progressInterval = setInterval(() => {
    const nowProcessed = STATS.processed;
    const delta = nowProcessed - lastProcessed;
    lastProcessed = nowProcessed;
    const rate = (delta * (1000 / interval)).toFixed(1);
    const elapsedMs = Date.now() - (_progressStartTime || Date.now());
    const elapsedStr = _formatElapsed(elapsedMs);

    const phase = _barPhase++ % BAR_WIDTH;
    const bar = Array.from({ length: BAR_WIDTH }).map((_, i) => (i === phase ? '█' : '─')).join('');

    const out = `${ANSI.cyan}[${ANSI.green}${bar}${ANSI.cyan}]${ANSI.reset} ` +
    `${ANSI.green}fetched:${STATS.fetched}${ANSI.reset} ` +
    `${ANSI.yellow}queued:${STATS.queued}${ANSI.reset} ` +
    `${ANSI.magenta}buffered:${STATS.buffered}${ANSI.reset} ` +
    `${ANSI.magenta}full:${STATS.full}${ANSI.reset} ` +
    `${ANSI.red}errors:${STATS.errors}${ANSI.reset} ` +
    `${ANSI.blue}processed:${STATS.processed}${ANSI.reset} ` +
    `${ANSI.cyan}inflight:${STATS.inflight}${ANSI.reset} ` +
    `${ANSI.bold}${rate}/s${ANSI.reset} ` +
    `${ANSI.cyan}elapsed:${elapsedStr}${ANSI.reset}`;

    try {
      process.stdout.write('\x1b[2K\r' + out);
    } catch (e) {
    }
  }, interval);
}

function stopProgressUpdate() {
  if (_progressInterval) {
    clearInterval(_progressInterval);
    _progressInterval = null;
    _progressStartTime = null;
    _barPhase = 0;
    try { process.stdout.write('\n'); } catch (_) {}
  }
}

async function logError(ctx, err) {
  try {
    const entry = {
      ts: new Date().toISOString(),
      ctx: ctx,
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : null,
    };
    await fs.appendFile(new URL('./errors.log', import.meta.url).pathname, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {
    // ignore logging failures
  }
}

async function loadState() {
  try {
    const s = await fs.readFile(STATE_FILE, 'utf8');
    const base = JSON.parse(s);
    try {
      const cs = await fs.readFile(CRAWLER_FILE, 'utf8');
      const cj = JSON.parse(cs);
      // support both old and new formats: { frontier: [...] } or { scraped: [url, ...] }
      if (cj && Array.isArray(cj.frontier)) {
        base.frontier = cj.frontier;
      } else if (cj && Array.isArray(cj.scraped)) {
        base.frontier = cj.scraped.map((u) => ({ url: u, depth: 0 }));
      }
    } catch (e) {
      // if crawler.json doesn't exist but .scraper.json contains a frontier, migrate it
      if (base && Array.isArray(base.frontier) && base.frontier.length > 0) {
        try {
          // write crawler file using the same shape as scraped.json: { scraped: [url, ...] }
          const scrapedUrls = base.frontier.map((f) => (typeof f === 'string' ? f : (f && f.url) ? f.url : null)).filter(Boolean);
          await fs.writeFile(CRAWLER_FILE, JSON.stringify({ scraped: scrapedUrls }, null, 2), 'utf8');
          const persist = { api_key: base.api_key, scraper_id: base.scraper_id, config: base.config };
          await fs.writeFile(STATE_FILE, JSON.stringify(persist, null, 2), 'utf8');
          base.frontier = persist.frontier || [];
        } catch (_) {
          // best-effort migration; ignore errors
        }
      }
    }

    base.frontier = base.frontier || [];
    base.visited = base.visited || {};
    base.api_key = base.api_key || null;
    base.scraper_id = base.scraper_id || null;
    base.config = base.config || {};
    return base;
  } catch (e) {
    return { api_key: null, scraper_id: null, config: {}, frontier: [], visited: {} };
  }
}

async function processQueueLoop(apiKey, scraperId, state, opts) {
  const pollInterval = (opts.poll_interval_seconds || DEFAULT_POLL_INTERVAL) * 1000;
  const concurrency = opts.concurrency || DEFAULT_CONCURRENCY;
  const ram_limit_mb = (opts.ram_limit_mb || process.env.RAM_LIMIT_MB) ? Number(opts.ram_limit_mb || process.env.RAM_LIMIT_MB) : null;
  const cpu_ops_per_sec = (opts.cpu_ops_per_sec || process.env.CPU_OPS_PER_SEC) ? Number(opts.cpu_ops_per_sec || process.env.CPU_OPS_PER_SEC) : null;
  const per_request_delay_ms = cpu_ops_per_sec && cpu_ops_per_sec > 0 ? Math.round(1000 / cpu_ops_per_sec) : 0;

  

  while (true) {
    if (ram_limit_mb) {
      const usageMb = (process.memoryUsage().rss || 0) / (1024 * 1024);
      if (usageMb > ram_limit_mb) {
        console.warn('Memory usage', Math.round(usageMb), 'MB exceeds limit', ram_limit_mb, 'MB — sleeping');
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
    }

    const items = await fetchQueuePending(apiKey, concurrency);
    if (!items || items.length === 0) {
      await new Promise((r) => setTimeout(r, pollInterval));
      continue;
    }

    for (const item of items) {
      try {
        const id = item.id;
        let payload = item.payload || null;
        if (typeof payload === 'string') {
          try { payload = JSON.parse(payload); } catch { payload = { url: payload }; }
        }
        const urlToFetch = payload && payload.url ? payload.url : null;
        if (!urlToFetch) {
          console.warn('queue item missing url', item);
          await ackQueue(apiKey, id);
          continue;
        }

        // fetch and build full payload (using persistent fetch)
        const res = await pfetch(urlToFetch, { method: 'GET' });
        const status = res.status;
        const html = await res.text();
        const title = extractTitle(html);
        const description = extractMetaDescription(html) || extractMeta(html, 'Description') || '';
        const canonical = extractCanonical(html, urlToFetch);
        const lang = extractLang(html) || (res.headers.get('content-language') || '').split(',')[0];
        const links = extractLinks(html, urlToFetch).slice(0, 200);
        const content_hash = await sha256hex(html);

        const u = new URL(urlToFetch);
        const host = u.hostname;

        const fullPayload = {
          url: urlToFetch,
          title,
          canonical: canonical || urlToFetch,
          outlinks_count: links.length,
          lang,
          description,
          status,
          fetches: 1,
          content_hash,
        };

        const r = await submit(apiKey, scraperId, host, JSON.stringify(fullPayload));
        slog('Processed queued', urlToFetch, '->', r.status, r.ok);

        // ack the queue item so server can mark it scraped
        const ack = await ackQueue(apiKey, id);
        slog('Ack', id, '->', ack.status, ack.ok);

        state.visited = state.visited || {};
        state.visited[urlToFetch] = Date.now();
        await saveState(state);
        await saveScraped(state);

        if (per_request_delay_ms > 0) await new Promise((r) => setTimeout(r, per_request_delay_ms));
      } catch (e) {
        console.error('processQueueLoop error', e && e.message ? e.message : e);
      }
    }
  }
}

// --- Worker pool for crawl fetch+parse ---
let _workerPool = null;
function createWorkerPool(size) {
  if (typeof Worker === 'undefined') return null;
  const workers = [];
  const free = [];
  const resolvers = new Map();
  let counter = 1;

  for (let i = 0; i < size; i++) {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (ev) => {
      const { taskId, result, error } = ev.data;
      const r = resolvers.get(taskId);
      if (r) {
        r({ result, error });
        resolvers.delete(taskId);
      }
      free.push(w);
    };
    w.onerror = (err) => {
      console.error('worker error', err);
    };
    workers.push(w);
    free.push(w);
  }

  async function runTask({ url }) {
    if (free.length === 0) {
      // wait for a free worker
      await new Promise((res) => setTimeout(res, 20));
      return runTask({ url });
    }
    const w = free.pop();
    const id = counter++;
    const p = new Promise((resolve) => {
      resolvers.set(id, resolve);
    });
    w.postMessage({ taskId: id, url });
    const out = await p;
    return out;
  }

  return { runTask, size, workers };
}


async function saveState(st) {
  // persist only stable fields to .scraper.json
  // ensure config has all defaults so autogenerated file is complete
  st.config = st.config || {};
  st.config.type = st.config.type || 'crawler';
  st.config.seeds = st.config.seeds || DEFAULT_SEEDS;
  st.config.max_pages = typeof st.config.max_pages !== 'undefined' ? st.config.max_pages : DEFAULT_MAX_PAGES;
  st.config.max_depth = typeof st.config.max_depth !== 'undefined' ? st.config.max_depth : DEFAULT_MAX_DEPTH;
  st.config.concurrency = typeof st.config.concurrency !== 'undefined' ? st.config.concurrency : DEFAULT_CONCURRENCY;
  st.config.workers = typeof st.config.workers !== 'undefined' ? st.config.workers : DEFAULT_WORKERS;
  st.config.test = typeof st.config.test !== 'undefined' ? st.config.test : false;
  st.config.test_duration_seconds = typeof st.config.test_duration_seconds !== 'undefined' ? st.config.test_duration_seconds : 60;
  st.config.mega_submit_batch_size = typeof st.config.mega_submit_batch_size !== 'undefined' ? st.config.mega_submit_batch_size : 50;
  st.config.mega_submit_only_on_full_batch = typeof st.config.mega_submit_only_on_full_batch !== 'undefined' ? st.config.mega_submit_only_on_full_batch : false;
  st.config.scraped_file = st.config.scraped_file || 'scraped.json';
  st.config.crawler_file = st.config.crawler_file || 'crawler.json';
  st.config.state_file = st.config.state_file || '.scraper.json';

  // persist only a minimal, user-facing subset of config keys
  const persist = {
    api_key: st.api_key,
    scraper_id: st.scraper_id,
    config: {
      type: st.config.type,
      seeds: st.config.seeds,
      max_pages: st.config.max_pages,
      max_depth: st.config.max_depth,
      concurrency: st.config.concurrency,
      workers: st.config.workers,
      test: st.config.test,
      test_duration_seconds: st.config.test_duration_seconds,
      mega_submit_batch_size: st.config.mega_submit_batch_size,
      mega_submit_only_on_full_batch: st.config.mega_submit_only_on_full_batch,
      scraped_file: st.config.scraped_file,
      crawler_file: st.config.crawler_file,
      state_file: st.config.state_file,
    },
  };
  try {
    await fs.writeFile(STATE_FILE, JSON.stringify(persist, null, 2), 'utf8');
  } catch (e) {
    // best-effort
  }

  // persist crawler runtime frontier separately
  try {
    // persist crawler runtime frontier as the same shape as scraped.json: { scraped: [url, ...] }
    const scrapedUrls = (st.frontier || []).map((f) => (typeof f === 'string' ? f : (f && f.url) ? f.url : null)).filter(Boolean);
    await fs.writeFile(CRAWLER_FILE, JSON.stringify({ scraped: scrapedUrls }, null, 2), 'utf8');
  } catch (e) {
    // best-effort
  }
}

async function saveScraped(state) {
  try {
    // only write scraped.json when running in `scraper` mode
    const mode = state && state.config && state.config.type ? state.config.type : 'crawler';
    if (mode !== 'scraper') return;
    const visited = state.visited || {};
    const arr = Object.keys(visited || {});
    await fs.writeFile(SCRAPED_FILE, JSON.stringify({ scraped: arr }, null, 2), 'utf8');
  } catch (e) {
    // best-effort
  }
}

async function registerApi(name = 'scraper-test') {
  const res = await pfetch(`${API_BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`register API failed: ${res.status}`);
  const j = await res.json();
  return j.api_key;
}

async function registerScraper(apiKey, name = 'local-scraper') {
  const res = await pfetch(`${API_BASE}/scraper/register`, {
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

  const res = await pfetch(url.toString(), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${apiKey}`, 'X-Scraper-Id': scraperId, 'content-type': 'application/json' },
    body,
  });
  const txt = await res.text();
  return { ok: res.ok, status: res.status, body: txt };
}

async function queueSubmit(apiKey, scraperId, source = 'crawler', payload = null) {
  const url = new URL(`${API_BASE}/queue/submit`);
  url.searchParams.set('source', source);
  url.searchParams.set('scraper_id', scraperId);

  const body = payload ? (typeof payload === 'string' ? payload : JSON.stringify(payload)) : JSON.stringify({ url: null });

  const res = await pfetch(url.toString(), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${apiKey}`, 'X-Scraper-Id': scraperId, 'content-type': 'application/json' },
    body,
  });
  const txt = await res.text();
  return { ok: res.ok, status: res.status, body: txt };
}

// --- mega-submit batching ---
let _megaBatch = [];
let _megaLastFlush = Date.now();

async function megaFlush(apiKey, scraperId, state) {
  if (_megaBatch.length === 0) return { ok: true, inserted: 0 };
  const batch = _megaBatch.splice(0, _megaBatch.length);
  const url = new URL(`${API_BASE}/queue/mega-submit`);
  url.searchParams.set('scraper_id', scraperId);
    try {
    const res = await pfetch(url.toString(), {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ items: batch }),
    });
    _megaLastFlush = Date.now();
    let j = null;
    try { j = await res.json(); } catch (_) { }
    if (res.ok) {
      const inserted = j && j.inserted ? Number(j.inserted) : 0;
      // reduce local buffered count by inserted (best-effort)
      STATS.buffered = Math.max(0, STATS.buffered - inserted);
      return { ok: true, status: res.status, body: j, inserted };
    } else {
      return { ok: false, status: res.status, body: j };
    }
  } catch (e) {
    // on error, requeue items at front
    _megaBatch = batch.concat(_megaBatch);
    logError('megaFlush-error', e).catch(()=>{});
    return { ok: false, error: e };
  }
}

async function enqueueMega(item, apiKey, scraperId, state, opts = {}) {
  _megaBatch.push(item);
  const batchSize = opts.mega_submit_batch_size || state.config.mega_submit_batch_size || 50;
  const intervalMs = (opts.mega_submit_interval_seconds || state.config.mega_submit_interval_seconds || 30) * 1000;
  const onlyOnFull = typeof opts.mega_submit_only_on_full_batch !== 'undefined' ? opts.mega_submit_only_on_full_batch : (state.config && state.config.mega_submit_only_on_full_batch);
  if (_megaBatch.length >= batchSize) {
    return await megaFlush(apiKey, scraperId, state);
  }
  if (Date.now() - _megaLastFlush >= intervalMs && !onlyOnFull) {
    return await megaFlush(apiKey, scraperId, state);
  }
  // not flushed to server yet — report buffered size instead of pretending server enqueue
  STATS.buffered = _megaBatch.length;
  return { ok: true, buffered: _megaBatch.length };
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

  const testMode = Boolean(opts.test || state.config.test);
  const testDurationMs = (opts.test_duration_seconds || state.config.test_duration_seconds || 60) * 1000;
  const testStart = Date.now();

    // ensure worker pool for crawling
    if (!_workerPool && typeof Worker !== 'undefined') {
      try {
        const workerCount = Number(opts.workers || state.config.workers || state.config.cpu_threads || concurrency || DEFAULT_CONCURRENCY) || DEFAULT_CONCURRENCY;
        slog('Creating worker pool size=', workerCount);
        _workerPool = createWorkerPool(workerCount);
      } catch (e) {
        console.warn('Failed to create worker pool, falling back to single-threaded', e && e.message ? e.message : e);
        _workerPool = null;
      }
    }

    while (state.frontier.length > 0 && processed < max_pages) {
    // if in test mode, stop after duration
    if (testMode && (Date.now() - testStart) >= testDurationMs) {
      break;
    }
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

    // dispatch batch to worker pool if available, otherwise fallback to single-threaded async
    if (_workerPool) {
      // run all worker tasks in parallel for this batch
      const taskPromises = batch.map((it) => _workerPool.runTask({ url: it.url }).then((res) => ({ it, res })));
      // mark these tasks as inflight
      STATS.inflight += taskPromises.length;
      let results = [];
      try {
        results = await Promise.all(taskPromises);
      } catch (e) {
        // if a runTask rejected unexpectedly, convert to partial results
        console.warn('worker pool runTask error', e && e.message ? e.message : e);
      }

      for (const entry of results) {
        const t = entry.it;
        const r = entry.res || {};
        try {
          const { result, error } = r;
          if (error) {
            STATS.errors++;
            logError('worker-task-error', error).catch(()=>{});
            processed += 1;
            STATS.processed++;
            continue;
          }
          const { url, status, title, description, canonical, lang, links, content_hash } = result || {};
          STATS.fetched++;
          const host = url ? new URL(url).hostname : '';
          const payloadMode = (opts.type || state.config.type || 'crawler');

          if (payloadMode === 'crawler') {
            // enqueue all discovered links concurrently to reduce await churn
            const enqueuePromises = [];
            for (const l of (links || [])) {
              const last = state.visited[l] || 0;
              if (last) continue;
              try {
                const lu = new URL(l);
                const lhost = lu.hostname;
                enqueuePromises.push(enqueueMega({ url: l, source: lhost, scraper_id: scraperId }, apiKey, scraperId, state, opts));
              } catch (e) {
                STATS.errors++;
                logError('enqueue-promise-create', e).catch(()=>{});
              }
            }
            const enResults = await Promise.allSettled(enqueuePromises);
                    for (const er of enResults) {
                      if (er.status === 'fulfilled') {
                        const val = er.value;
                        if (val && typeof val.inserted !== 'undefined') {
                          STATS.queued += Number(val.inserted);
                        } else if (val && typeof val.buffered !== 'undefined') {
                          // local buffer size — reflect it but do not count as server queued
                          STATS.buffered = Number(val.buffered);
                        } else {
                          STATS.errors++;
                          logError('enqueue-result-unexpected', val).catch(()=>{});
                        }
                      } else {
                        STATS.errors++;
                        logError('enqueue-result-rejected', er).catch(()=>{});
                      }
                    }

            if (t.depth + 1 <= max_depth) {
              for (const l of (links || [])) {
                const last = state.visited[l] || 0;
                const now = Date.now();
                if (!last || (now - last) >= (opts.revisit_after_seconds || DEFAULT_REVISIT_AFTER) * 1000) {
                  state.frontier.push({ url: l, depth: t.depth + 1 });
                }
              }
            }
          } else {
            const payload = { url, title, canonical: canonical || url, outlinks_count: (links || []).length, lang, description, status, fetches: 1, content_hash };
            const rsub = await submit(apiKey, scraperId, host, JSON.stringify(payload));
            if (rsub && rsub.ok) STATS.full++;
            if (t.depth + 1 <= max_depth) {
              for (const l of (links || [])) {
                const last = state.visited[l] || 0;
                const now = Date.now();
                if (!last || (now - last) >= (opts.revisit_after_seconds || DEFAULT_REVISIT_AFTER) * 1000) {
                  state.frontier.push({ url: l, depth: t.depth + 1 });
                }
              }
            }
          }
        } catch (e) {
          STATS.errors++;
          logError('batch-process-error', e).catch(()=>{});
        } finally {
          processed += 1;
          STATS.processed++;
          // task finished
          STATS.inflight = Math.max(0, STATS.inflight - 1);
        }
      }
    } else {
      // mark non-worker batch as inflight
      STATS.inflight += batch.length;
      await Promise.all(batch.map(async (it) => {
        try {
          if (ram_limit_mb) {
            const usageMb = (process.memoryUsage().rss || 0) / (1024 * 1024);
            if (usageMb > ram_limit_mb) {
              console.warn('Memory usage', Math.round(usageMb), 'MB exceeds limit', ram_limit_mb, 'MB — sleeping');
              await new Promise((r) => setTimeout(r, 5000));
            }
          }

          const res = await pfetch(it.url, { method: 'GET' });
          const status = res.status;
          const ct = res.headers.get('content-type') || '';
          const html = await res.text();
          STATS.fetched++;

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
                const payloadMode = (opts.type || state.config.type || 'crawler');

                if (payloadMode === 'crawler') {
                  // In crawler mode, submit discovered links as URL-only payloads so the server queues them.
                  for (const l of links) {
                    // skip links we've already visited
                    const last = state.visited[l] || 0;
                    if (last) continue;
                    try {
                      const lu = new URL(l);
                      const lhost = lu.hostname;
                      const linkPayload = { url: l };
                      const en = await enqueueMega({ url: l, source: lhost, scraper_id: scraperId }, apiKey, scraperId, state, opts);
                      slog('Crawler queued link', l, '->', en && en.status ? en.status : 'pending');
                      if (en && typeof en.inserted !== 'undefined') {
                        STATS.queued += Number(en.inserted);
                      } else if (en && typeof en.buffered !== 'undefined') {
                        STATS.buffered = Number(en.buffered);
                      } else {
                        STATS.errors++;
                        logError('enqueue-mega-unexpected', val).catch(()=>{});
                      }
                    } catch (e) {
                      console.warn('Crawler queue submit failed for', l, e && e.message ? e.message : e);
                      STATS.errors++;
                      logError('crawler-queue-submit-failed', { url: l, error: e && e.message ? e.message : String(e) }).catch(()=>{});
                    }
                  }

                  // still populate local frontier so crawler can continue discovering deeper links
                  if (it.depth + 1 <= max_depth) {
                    for (const l of links) {
                      const last = state.visited[l] || 0;
                      const now = Date.now();
                      if (!last || (now - last) >= (opts.revisit_after_seconds || DEFAULT_REVISIT_AFTER) * 1000) {
                        state.frontier.push({ url: l, depth: it.depth + 1 });
                      }
                    }
                  }
                } else {
                  // In scraper mode, submit full page payloads
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
                  if (r && r.ok) STATS.full++;
                  slog('Submitting', it.url, '->', r.status, r.ok, r.body);

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
                }
        } catch (e) {
          console.error('fetch error', it.url, e.message || e);
        } finally {
          processed += 1;
          STATS.processed++;
          STATS.inflight = Math.max(0, STATS.inflight - 1);
        }
      }));
    }

    await saveState(state);
    await saveScraped(state);
  }
  // if in test mode, print summary
  if (testMode) {
    slog('Test mode summary: fetched=%d queued_submitted=%d full_submitted=%d errors=%d processed=%d', STATS.fetched, STATS.queued, STATS.full, STATS.errors, STATS.processed);
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
      slog('Registering API key...');
      apiKey = await registerApi('kse-scraper-crawler');
      state.api_key = apiKey;
      await saveState(state);
      slog('Got api_key');
    }

    if (!scraperId) {
      slog('Registering scraper...');
      scraperId = await registerScraper(apiKey, 'bun-crawler');
      state.scraper_id = scraperId;
      await saveState(state);
      slog('Got scraper id');
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

    // show a cleaned, user-facing config when starting (omit hidden/internal keys)
    const displayConfig = {
      type: state.config.type,
      seeds: state.config.seeds,
      max_pages: state.config.max_pages,
      max_depth: state.config.max_depth,
      concurrency: state.config.concurrency,
      workers: state.config.workers,
      test: state.config.test,
      test_duration_seconds: state.config.test_duration_seconds,
      mega_submit_batch_size: state.config.mega_submit_batch_size,
      mega_submit_interval_seconds: state.config.mega_submit_interval_seconds,
      scraped_file: state.config.scraped_file,
      crawler_file: state.config.crawler_file,
      state_file: state.config.state_file,
      continuous: state.config.continuous,
    };
    slog('Starting with config:', displayConfig);
    startProgressUpdate();
      // start background mega-flush when running
      if (!_megaFlushInterval) {
        const flushIntervalMs = ((state.config.mega_submit_interval_seconds || 30) * 1000) / 2;
        _megaFlushInterval = setInterval(() => {
          try {
            megaFlush(state.api_key || apiKey, state.scraper_id || scraperId, state).catch(() => {});
          } catch (_) {}
        }, Math.max(1000, flushIntervalMs));
      }
    const mode = state.config.type || 'crawler';
    if (mode === 'scraper') {
      slog('Running in scraper mode: polling server queue and processing items');
      await processQueueLoop(apiKey, scraperId, state, state.config);
    } else {
      slog('Running in crawler mode: discover links and submit URLs to server');
      do {
        await crawlLoop(apiKey, scraperId, state, state.config);
        slog('Crawl iteration finished');
        if (state.config.continuous) {
          const wait = (state.config.poll_interval_seconds || DEFAULT_POLL_INTERVAL) * 1000;
          slog(`Sleeping ${wait/1000}s before next crawl`);
          await new Promise(r => setTimeout(r, wait));
        }
      } while (state.config.continuous);
      slog('Crawl finished (continuous disabled)');
    }
    } catch (e) {
    console.error('Error:', e);
    process.exitCode = 1;
  } finally {
    stopProgressUpdate();
    if (_megaFlushInterval) {
      clearInterval(_megaFlushInterval);
      _megaFlushInterval = null;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].endsWith('index.js'))) {
  main();
}
