import { parse } from 'node-html-parser'

const API_BASE = process.env.API_BASE || 'http://localhost:3000'
const API_KEY = process.env.API_KEY || ''
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL_MS || 3000)
const CONCURRENCY = Number(process.env.CONCURRENCY || 8)
const FETCH_TIMEOUT = Number(process.env.FETCH_TIMEOUT_MS || 15000)
const MAX_LINKS = Number(process.env.MAX_LINKS || 2000)

function authHeaders() {
  const h = { 'Accept': 'application/json' }
  if (API_KEY) h['Authorization'] = `Bearer ${API_KEY}`
  return h
}

async function claimJob() {
  const res = await fetch(`${API_BASE}/crawler/next`, { method: 'POST', headers: { ...authHeaders() } })
  if (res.status === 204) return null
  if (!res.ok) throw new Error(`claimJob failed: ${res.status}`)
  return res.json()
}

function timeoutFetch(url, opts = {}, timeout = FETCH_TIMEOUT) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeout)
  return fetch(url, { signal: controller.signal, ...opts }).finally(() => clearTimeout(id))
}

// Simple robots handling (ksebot)
const ROBOTS_AGENT = 'ksebot'
const robotsCache = new Map()
function normalizeLine(line) { const idx = line.indexOf('#'); if (idx >= 0) line = line.slice(0, idx); return line.trim() }
function parseRobotsTxt(text) {
  const lines = text.split(/\r?\n/).map(normalizeLine).filter(Boolean)
  const sections = []
  let cur = { agents: [], rules: [] }
  for (const l of lines) {
    const [k, ...vparts] = l.split(':')
    if (!k) continue
    const key = k.trim().toLowerCase()
    const value = vparts.join(':').trim()
    if (key === 'user-agent') { if (cur.agents.length || cur.rules.length) { sections.push(cur); cur = { agents: [], rules: [] } } cur.agents.push(value.toLowerCase()) }
    else if (key === 'disallow' || key === 'allow') cur.rules.push({ type: key, path: value })
    else if (key === 'crawl-delay') cur.rules.push({ type: 'crawl-delay', value: Number(value) || 0 })
  }
  if (cur.agents.length || cur.rules.length) sections.push(cur)
  return sections
}

async function fetchRobotsForOrigin(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin)
  const url = `${origin.replace(/\/$/, '')}/robots.txt`
  try {
    const res = await timeoutFetch(url, { method: 'GET', headers: { 'User-Agent': ROBOTS_AGENT } }, 5000)
    if (!res.ok) throw new Error('no robots')
    const txt = await res.text()
    const sections = parseRobotsTxt(txt)
    let crawl = null
    for (const s of sections) {
      if (s.agents.includes(ROBOTS_AGENT) || s.agents.includes('*')) {
        for (const r of s.rules) if (r.type === 'crawl-delay') crawl = r.value
        if (crawl != null) break
      }
    }
    const entry = { sections, crawlDelay: crawl, fetchedAt: Date.now() }
    robotsCache.set(origin, entry)
    return entry
  } catch (err) {
    const entry = { sections: [], crawlDelay: null, fetchedAt: Date.now() }
    robotsCache.set(origin, entry)
    return entry
  }
}

function longestMatchRule(rules, path) {
  let best = null; let bestLen = -1
  for (const r of rules) {
    if (!r.path) continue
    if (path.startsWith(r.path)) { const len = r.path.length; if (len > bestLen) { bestLen = len; best = r } }
  }
  return best
}

async function isUrlAllowed(urlStr) {
  try {
    const u = new URL(urlStr)
    const origin = u.origin
    const path = u.pathname + (u.search || '')
    const robots = await fetchRobotsForOrigin(origin)
    if (!robots.sections.length) return { allowed: true, crawlDelay: robots.crawlDelay }
    let matchedSection = null
    for (const s of robots.sections) if (s.agents.includes(ROBOTS_AGENT)) matchedSection = s
    if (!matchedSection) { for (const s of robots.sections) if (s.agents.includes('*')) matchedSection = s }
    if (!matchedSection) return { allowed: true, crawlDelay: robots.crawlDelay }
    const rule = longestMatchRule(matchedSection.rules, path)
    if (!rule) return { allowed: true, crawlDelay: robots.crawlDelay }
    return { allowed: rule.type !== 'disallow', crawlDelay: robots.crawlDelay }
  } catch (e) { return { allowed: true, crawlDelay: null } }
}

function extractLinks(html, base) {
  const root = parse(html)
  const anchors = root.querySelectorAll('a')
  const links = new Set()
  for (const a of anchors) {
    const href = a.getAttribute('href')
    if (!href) continue
    const low = href.trim().toLowerCase()
    if (low.startsWith('mailto:') || low.startsWith('javascript:') || low.startsWith('tel:')) continue
    try { const u = new URL(href, base); links.add(u.toString()) } catch (e) { continue }
    if (links.size >= MAX_LINKS) break
  }
  return Array.from(links)
}

async function fetchSitemap(origin) {
  const sitemapUrl = `${origin.replace(/\/$/, '')}/sitemap.xml`
  try {
    const res = await timeoutFetch(sitemapUrl, { method: 'GET', headers: { 'User-Agent': ROBOTS_AGENT } }, 8000)
    if (!res.ok) return []
    const txt = await res.text()
    // extract <loc> tags
    const locs = [...txt.matchAll(/<loc\s*>\s*([^<]+?)\s*<\/loc>/gi)].map(m => m[1].trim())
    return locs
  } catch (e) { return [] }
}

async function reportResult(jobId, discovered) {
  const res = await fetch(`${API_BASE}/crawler/${jobId}`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: jobId, discovered })
  })
  if (!res.ok) throw new Error(`reportResult failed: ${res.status}`)
  return res
}

async function reportError(jobId, url, err) {
  try {
    await fetch(`${API_BASE}/crawler/${jobId}/error`, {
      method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ id: jobId, url, error: String(err) })
    })
  } catch (e) { console.error('failed to report error', e.message) }
}

async function handleJob(job) {
  const { id, url } = job
  console.log('crawl', id, url)
  try {
    const { allowed } = await isUrlAllowed(url)
    if (!allowed) { console.log('robots disallow', url); await reportResult(id, []); return }

    const res = await timeoutFetch(url, { method: 'GET', headers: { 'User-Agent': 'kse-crawler/1.0' } })
    if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`)
    const html = await res.text()
    const links = extractLinks(html, url)

    // try sitemap on apex domain for extra links
    let sitemapLinks = []
    try {
      const u = new URL(url)
      const origin = u.origin
      sitemapLinks = await fetchSitemap(origin)
    } catch (e) { /* ignore */ }

    const discovered = Array.from(new Set([...links, ...sitemapLinks])).slice(0, MAX_LINKS)
    await reportResult(id, discovered)
    console.log('reported', discovered.length, 'links for', id)
  } catch (err) {
    console.error('job error', id, err.message)
    await reportError(id, job.url, err)
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function workerLoop(i) {
  console.log('worker', i, 'started')
  while (true) {
    try {
      const job = await claimJob()
      if (!job) { await sleep(POLL_INTERVAL); continue }
      await handleJob(job)
    } catch (e) { console.error('worker error', e.message); await sleep(POLL_INTERVAL) }
  }
}

async function main() {
  console.log('crawler started; workers=', CONCURRENCY)
  const workers = []
  for (let i = 0; i < CONCURRENCY; i++) workers.push(workerLoop(i))
  await Promise.all(workers)
}

if (import.meta.main) main()
