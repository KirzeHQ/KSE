
import { parse } from "node-html-parser";
import fs from "fs";
import crypto from "crypto";

const API_BASE = process.env.API_BASE || "http://localhost:3000/api/v1";
const API_KEY = process.env.API_KEY || "";
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL_MS || 5000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const FETCH_TIMEOUT = Number(process.env.FETCH_TIMEOUT_MS || 15000);
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 1000);
const SUBMIT_FORMAT = (process.env.SUBMIT_FORMAT || 'bin').toLowerCase();

// frontier and buffers
const frontier = [];
const seenUrls = new Set();
let visitedCount = 0;

const discoveredLinksBuffer = [];
let discoveredLinksCount = 0;

let submissionsCount = 0;
let failedSubmissions = 0;
let localJobIdCounter = 0;
const startTime = Date.now();

const LOG_LINES = 5;
const logs = [];
let recordedCount = 0; // total records successfully submitted
let uiInitialized = false;
const UI_LINES = LOG_LINES + 4;

function addLog(msg) {
  try {
    const t = new Date().toISOString().replace('T', ' ').slice(11, 19);
    const line = `${t} ${String(msg)}`;
    logs.push(line);
    if (logs.length > 1000) logs.shift();
  } catch (e) {}
}


function authHeaders(accept = "application/json") {
  const h = { Accept: accept };
  if (API_KEY) h["Authorization"] = `Bearer ${API_KEY}`;
  return h;
}

function timeoutFetch(url, opts = {}, timeout = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { signal: controller.signal, ...opts }).finally(() => clearTimeout(id));
}

function parseHead(html) {
  const root = parse(html);
  const htmlTag = root.querySelector("html");
  const head = root.querySelector("head") || root;

  const title = head.querySelector("title")?.text?.trim() || null;
  const description = head.querySelector('meta[name="description"]')?.getAttribute("content") || null;
  const siteName = head.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || head.querySelector('meta[name="application-name"]')?.getAttribute('content') || null;
  const lang = htmlTag?.getAttribute("lang") || null;

  const body = root.querySelector("body");
  let content = body ? body.text.trim() : "";
  content = content.replace(/\s+/g, " ").trim().slice(0, 20000);

  return { title, description, content, lang, siteName };
}

function extractLinks(html, base) {
  const root = parse(html);
  const anchors = root.querySelectorAll("a");
  const links = new Set();
  for (const a of anchors) {
    const href = a.getAttribute("href");
    if (!href) continue;
    const low = href.trim().toLowerCase();
    if (low.startsWith("mailto:") || low.startsWith("javascript:") || low.startsWith("tel:")) continue;
    try {
      const u = new URL(href, base);
      links.add(u.toString());
    } catch (e) {
      continue;
    }
  }
  return Array.from(links);
}

function detectRedirectTargets(html, base) {
  const targets = new Set();
  try {
    for (const m of html.matchAll(/<meta[^>]*http-equiv=["']?refresh["']?[^>]*content=["']?([^"'>]+)["']?[^>]*>/gi)) {
      const content = (m[1] || "").trim();
      const urlMatch = content.match(/url=(.*)/i);
      if (urlMatch && urlMatch[1]) {
        const t = urlMatch[1].trim().replace(/^['"]|['"]$/g, "");
        try { targets.add(new URL(t, base).toString()); } catch (e) {}
      }
    }

    const jsPatterns = [
      /window\.location\.href\s*=\s*['"]([^'"]+)['"]/gi,
      /location\.href\s*=\s*['"]([^'"]+)['"]/gi,
      /window\.location\.replace\(\s*['"]([^'"]+)['"]\s*\)/gi,
      /location\.replace\(\s*['"]([^'"]+)['"]\s*\)/gi,
      /window\.location\.assign\(\s*['"]([^'"]+)['"]\s*\)/gi,
      /location\s*=\s*['"]([^'"]+)['"]/gi,
    ];
    for (const rx of jsPatterns) {
      for (const m of html.matchAll(rx)) {
        const t = m[1];
        if (!t) continue;
        try { targets.add(new URL(t, base).toString()); } catch (e) {}
      }
    }
  } catch (e) {}
  return Array.from(targets);
}

async function fetchSitemap(origin) {
  const sitemapUrl = `${origin.replace(/\/$/, "")}/sitemap.xml`;
  try {
    const res = await timeoutFetch(sitemapUrl, { method: "GET", headers: { "User-Agent": "kse-indexer/1.0" } }, 8000);
    if (!res.ok) return [];
    const txt = await res.text();
    const locs = [...txt.matchAll(/<loc\s*>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1].trim());
    return locs;
  } catch (e) {
    return [];
  }
}

const ROBOTS_AGENT = "ksebot";
const robotsCache = new Map();
const lastAccess = new Map();

function normalizeLine(line) {
  const idx = line.indexOf("#");
  if (idx >= 0) line = line.slice(0, idx);
  return line.trim();
}

function parseRobotsTxt(text) {
  const lines = text.split(/\r?\n/).map(normalizeLine).filter(Boolean);
  const sections = [];
  let cur = { agents: [], rules: [] };
  for (const l of lines) {
    const [k, ...vparts] = l.split(":");
    if (!k) continue;
    const key = k.trim().toLowerCase();
    const value = vparts.join(":").trim();
    if (key === "user-agent") {
      if (cur.agents.length || cur.rules.length) { sections.push(cur); cur = { agents: [], rules: [] }; }
      cur.agents.push(value.toLowerCase());
    } else if (key === "disallow" || key === "allow") {
      cur.rules.push({ type: key, path: value });
    } else if (key === "crawl-delay") {
      cur.rules.push({ type: "crawl-delay", value: Number(value) || 0 });
    }
  }
  if (cur.agents.length || cur.rules.length) sections.push(cur);
  return sections;
}

async function fetchRobotsForOrigin(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  const url = `${origin.replace(/\/$/, "")}/robots.txt`;
  try {
    const res = await timeoutFetch(url, { method: "GET", headers: { "User-Agent": ROBOTS_AGENT } }, 5000);
    if (!res.ok) throw new Error("no robots");
    const txt = await res.text();
    const sections = parseRobotsTxt(txt);
    let crawl = null;
    for (const s of sections) {
      if (s.agents.includes(ROBOTS_AGENT) || s.agents.includes("*")) {
        for (const r of s.rules) if (r.type === "crawl-delay") crawl = r.value;
        if (crawl != null) break;
      }
    }
    const entry = { sections, crawlDelay: crawl, fetchedAt: Date.now() };
    robotsCache.set(origin, entry);
    return entry;
  } catch (err) {
    const entry = { sections: [], crawlDelay: null, fetchedAt: Date.now() };
    robotsCache.set(origin, entry);
    return entry;
  }
}

function longestMatchRule(rules, path) {
  let best = null;
  let bestLen = -1;
  for (const r of rules) {
    if (!r.path) continue;
    if (path.startsWith(r.path)) {
      const len = r.path.length;
      if (len > bestLen) { bestLen = len; best = r; }
    }
  }
  return best;
}

async function isUrlAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    const origin = u.origin;
    const path = u.pathname + (u.search || "");
    const robots = await fetchRobotsForOrigin(origin);
    if (!robots.sections.length) return { allowed: true, crawlDelay: robots.crawlDelay };
    let matchedSection = null;
    for (const s of robots.sections) if (s.agents.includes(ROBOTS_AGENT)) matchedSection = s;
    if (!matchedSection) { for (const s of robots.sections) if (s.agents.includes("*")) matchedSection = s; }
    if (!matchedSection) return { allowed: true, crawlDelay: robots.crawlDelay };
    const rule = longestMatchRule(matchedSection.rules, path);
    if (!rule) return { allowed: true, crawlDelay: robots.crawlDelay };
    return { allowed: rule.type !== "disallow", crawlDelay: robots.crawlDelay };
  } catch (e) { return { allowed: true, crawlDelay: null }; }
}

function encodeStringWithLen(str) {
  const b = Buffer.from(String(str || ''), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length);
  return Buffer.concat([len, b]);
}

function encodeRecord(rec) {
  // rec: { url, title, content, description, sitename, crawl_date (ms), status_code, outlinks: [] }
  const parts = [];
  parts.push(encodeStringWithLen(rec.url || ''));
  parts.push(encodeStringWithLen(rec.title || ''));
  parts.push(encodeStringWithLen(rec.content || ''));
  parts.push(encodeStringWithLen(rec.description || ''));
  parts.push(encodeStringWithLen(rec.sitename || ''));

  const dateBuf = Buffer.alloc(8);
  try { dateBuf.writeBigUInt64BE(BigInt(rec.crawl_date || Date.now())); } catch (e) { dateBuf.writeBigUInt64BE(BigInt(Date.now())); }
  parts.push(dateBuf);

  const sc = Buffer.alloc(2);
  sc.writeUInt16BE(Number(rec.status_code || 0));
  parts.push(sc);

  const out = Array.isArray(rec.outlinks) ? rec.outlinks : [];
  const oc = Buffer.alloc(4);
  oc.writeUInt32BE(out.length);
  parts.push(oc);
  for (const o of out) {
    parts.push(encodeStringWithLen(o));
  }

  const body = Buffer.concat(parts);
  const hash = crypto.createHash('sha256').update(body).digest();
  return Buffer.concat([body, hash]);
}

async function flushBuffer() {
  if (discoveredLinksCount === 0) return;
  const batch = discoveredLinksBuffer.splice(0, BATCH_SIZE);
  discoveredLinksCount -= batch.length;
  const batchId = ++localJobIdCounter;

    addLog(`submitting batch id=${batchId} size=${batch.length} format=${SUBMIT_FORMAT} (buffer now ${discoveredLinksCount})`);
  try {
    let res;
    if (SUBMIT_FORMAT === 'json') {
      // JSON mode: send structured items for compatibility
      const items = batch.map((rec, idx) => ({
        id: batchId * 1000000 + idx,
        discovered: Array.isArray(rec.outlinks) ? rec.outlinks : [],
        url: rec.url,
        title: rec.title || '',
        content: rec.content || '',
        description: rec.description || '',
        sitename: rec.sitename || '',
        crawl_date: rec.crawl_date || Date.now(),
        status_code: rec.status_code || 0
      }));
      const payload = JSON.stringify({ items });
      res = await fetch(`${API_BASE}/indexer/submit`, {
        method: 'PATCH',
        headers: { ...authHeaders('application/json'), 'Content-Type': 'application/json', 'X-URL-Count': String(batch.length) },
        body: payload,
      });
    } else {
      // binary mode (default)
      const parts = batch.map(rec => encodeRecord(rec));
      const bin = Buffer.concat(parts);
      res = await fetch(`${API_BASE}/indexer/submit`, {
        method: "PATCH",
        headers: { ...authHeaders('application/octet-stream'), "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename=batched_${batchId}.bin`, "X-URL-Count": String(batch.length) },
        body: bin,
      });
    }

    if (!res || !res.ok) throw new Error(`batch submit failed: ${res ? res.status : 'no-response'}`);
    submissionsCount++;
    recordedCount += batch.length;
    addLog(`batch ${batchId} submitted OK (total submissions=${submissionsCount} total_records_sent=${recordedCount})`);
  } catch (e) {
    // requeue
    discoveredLinksBuffer.unshift(...batch);
    discoveredLinksCount += batch.length;
    failedSubmissions++;
    addLog(`[ERROR] batch ${batchId} submit error: ${e && e.message ? e.message : e}`);
  }
}

function maybeFlush() {
  if (discoveredLinksCount >= BATCH_SIZE) {
    flushBuffer().catch((e) => addLog(`[ERROR] flushBuffer failed: ${e && e.message ? e.message : e}`));
  }
}

async function handleUrl(url) {
  addLog(`processing ${url}`);
  try {
    const { allowed, crawlDelay } = await isUrlAllowed(url);
    if (!allowed) {
      addLog(`disallowed by robots: ${url}`);
      visitedCount++;
      return;
    }

    try {
      const u = new URL(url);
      const origin = u.origin;
      const now = Date.now();
      const last = lastAccess.get(origin) || 0;
      const delayMs = crawlDelay && Number(crawlDelay) > 0 ? Number(crawlDelay) * 1000 : 0;
      if (delayMs > 0 && now - last < delayMs) {
        await sleep(delayMs - (now - last));
      }
      lastAccess.set(origin, Date.now());
    } catch (e) {}

    const res = await timeoutFetch(url, { method: 'GET', headers: { 'User-Agent': 'kse-indexer/1.0' } });
    if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
    const html = await res.text();
    const links = extractLinks(html, url);

    let sitemapLinks = [];
    try { sitemapLinks = await fetchSitemap(new URL(url).origin); } catch (e) {}

    const redirectTargets = detectRedirectTargets(html, url);
    const discoveredSet = new Set([...(links || []), ...(sitemapLinks || []), ...(redirectTargets || [])]);
    const discovered = Array.from(discoveredSet);
    if (discovered.length) addLog(`discovered ${discovered.length} links for ${url} sample: ${JSON.stringify(discovered.slice(0,5))}`);

    // prepare record for this page
    const head = parseHead(html);
    const siteName = head.siteName || (() => { try { return new URL(url).hostname } catch (e) { return ''; } })();
    const rec = {
      url: url,
      title: head.title || '',
      content: head.content || '',
      description: head.description || '',
      sitename: siteName,
      crawl_date: Date.now(),
      status_code: (res && res.status) || 0,
      outlinks: discovered,
    };

    // enqueue newly seen links
    let added = 0;
    for (const l of discovered) {
      if (!seenUrls.has(l)) { seenUrls.add(l); frontier.push(l); added++; }
    }

    // buffer the page record (one record per scraped URL)
    discoveredLinksBuffer.push(rec);
    discoveredLinksCount += 1;
    visitedCount++;

    maybeFlush();
  } catch (err) {
    addLog(`[ERROR] handleUrl error ${url} ${err && err.message ? err.message : err}`);
    visitedCount++;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function workerLoop(workerId) {
  addLog(`worker ${workerId} started`);
  while (true) {
    try {
      const url = frontier.shift();
      if (!url) { await sleep(POLL_INTERVAL); continue; }
      await handleUrl(url);
    } catch (err) {
      addLog(`[ERROR] worker ${workerId} error ${err && err.message ? err.message : err}`);
      await sleep(POLL_INTERVAL);
    }
  }
}

function drawUI() {
  const cols = process.stdout.columns || 80;
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const rate = submissionsCount / Math.max(1, Math.floor((Date.now() - startTime) / 60000));
  const waitingToFlush = discoveredLinksBuffer.length;
  const stats = `Uptime:${uptime}s Visited:${visitedCount} Seen:${seenUrls.size} Frontier:${frontier.length} Buffer:${discoveredLinksCount} Waiting:${waitingToFlush} Subs:${submissionsCount} Fail:${failedSubmissions} Rate:${Math.round(rate)}/min Recorded:${recordedCount}`;

  const sep = '='.repeat(Math.min(cols, 80));

  // prepare log lines (last LOG_LINES)
  const last = logs.slice(-LOG_LINES);
  const padStart = Math.max(0, LOG_LINES - last.length);

  const lines = [];
  lines.push(stats.slice(0, cols).padEnd(cols));
  lines.push(sep.slice(0, cols).padEnd(cols));
  lines.push('Logs:'.padEnd(cols));
  for (let i = 0; i < padStart; i++) lines.push(''.padEnd(cols));
  for (const l of last) lines.push(l.slice(0, cols).padEnd(cols));
  lines.push(sep.slice(0, cols).padEnd(cols));

  try {
    if (!uiInitialized) {
      process.stdout.write(lines.join('\n') + '\n');
      uiInitialized = true;
    } else {
      process.stdout.write(`\x1b[${UI_LINES}A`);
      for (const ln of lines) {
        process.stdout.write(ln + '\n');
      }
    }
  } catch (e) {
    try { process.stdout.write(stats + '\n'); } catch (err) {}
  }
}

async function mainLoop() {
  try {
    try { process.stdout.write('\x1b[?25l'); } catch (e) {}

    let seeds = [];
    if (process.env.SEEDS) {
      seeds = process.env.SEEDS.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
    }
    try {
      if (fs.existsSync('./seeds.txt')) {
        const txt = fs.readFileSync('./seeds.txt', 'utf8');
        const fileSeeds = txt.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        seeds = seeds.concat(fileSeeds);
      }
    } catch (e) { addLog(`[WARN] reading seeds file error: ${e && e.message ? e.message : e}`); }

    for (const s of seeds) {
      if (!seenUrls.has(s)) { seenUrls.add(s); frontier.push(s); }
    }

    const workers = Math.max(1, CONCURRENCY);
    for (let i = 0; i < workers; i++) {
      workerLoop(i + 1).catch((e) => addLog(`[ERROR] worker ${i+1} crashed: ${e && e.message ? e.message : e}`));
    }

    drawUI();
    setInterval(drawUI, 1000);

    const FLUSH_INTERVAL_MS = Number(process.env.FLUSH_INTERVAL_MS || 15000);
    if (FLUSH_INTERVAL_MS > 0) {
      setInterval(() => { flushBuffer().catch(e => addLog(`[ERROR] periodic flush failed: ${e && e.message ? e.message : e}`)); }, FLUSH_INTERVAL_MS);
    }

    addLog(`mainLoop started: workers=${workers} seeds=${seeds.length} flush_interval_ms=${FLUSH_INTERVAL_MS}`);
  } catch (e) {
    addLog(`[ERROR] mainLoop error: ${e && e.message ? e.message : e}`);
  }
}

if (import.meta.main) mainLoop();

process.on("SIGINT", async () => {
  addLog("SIGINT received - flushing buffer before exit");
  try { await flushBuffer(); } catch (e) { addLog(`[ERROR] ${e && e.message ? e.message : e}`); }
  drawUI();
  try { process.stdout.write('\x1b[?25h'); } catch (e) {}
  process.exit(0);
});

process.on("SIGTERM", async () => {
  addLog("SIGTERM received - flushing buffer before exit");
  try { await flushBuffer(); } catch (e) { addLog(`[ERROR] ${e && e.message ? e.message : e}`); }
  drawUI();
  try { process.stdout.write('\x1b[?25h'); } catch (e) {}
  process.exit(0);
});
