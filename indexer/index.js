import { parse } from 'node-html-parser'

const API_BASE = process.env.API_BASE || 'http://localhost:3000'
const API_KEY = process.env.API_KEY || ''
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL_MS || 5000)
const CONCURRENCY = Number(process.env.CONCURRENCY || 4)
const FETCH_TIMEOUT = Number(process.env.FETCH_TIMEOUT_MS || 15000)

function authHeaders() {
	const h = { 'Accept': 'application/json' }
	if (API_KEY) h['Authorization'] = `Bearer ${API_KEY}`
	return h
}

async function claimJob() {
	const res = await fetch(`${API_BASE}/indexer/next`, {
		method: 'POST',
		headers: { ...authHeaders() }
	})
	if (res.status === 204) return null
	if (!res.ok) throw new Error(`claimJob failed: ${res.status}`)
	return res.json()
}

function timeoutFetch(url, opts = {}, timeout = FETCH_TIMEOUT) {
	const controller = new AbortController()
	const id = setTimeout(() => controller.abort(), timeout)
	return fetch(url, { signal: controller.signal, ...opts }).finally(() => clearTimeout(id))
}

function parseHead(html) {
  const root = parse(html)
  const htmlTag = root.querySelector('html')
  const head = root.querySelector('head') || root

  const title = head.querySelector('title')?.text?.trim() || null
  const description = head.querySelector('meta[name="description"]')?.getAttribute('content') || null
  const lang = htmlTag?.getAttribute('lang') || null

  const body = root.querySelector('body')
  let content = body ? body.text.trim() : ''

  content = content.replace(/\s+/g, ' ').trim().slice(0, 20000)

  return { title, description, content, lang }
}

async function sendResult(jobId, url, payloadObj) {
	const bin = new TextEncoder().encode(JSON.stringify(payloadObj))
	const res = await fetch(`${API_BASE}/indexer/${jobId}/result`, {
		method: 'POST',
		headers: {
			...authHeaders(),
			'Content-Type': 'application/octet-stream'
		},
		body: bin
	})
	if (!res.ok) throw new Error(`sendResult failed: ${res.status}`)
	return res
}

// robots.txt handling
const ROBOTS_AGENT = 'ksebot'
const robotsCache = new Map() // origin -> { sections: [...], crawlDelay: number, fetchedAt }
const lastAccess = new Map() // origin -> timestamp(ms)

function normalizeLine(line) {
	const idx = line.indexOf('#')
	if (idx >= 0) line = line.slice(0, idx)
	return line.trim()
}

function parseRobotsTxt(text) {
	const lines = text.split(/\r?\n/).map(normalizeLine).filter(Boolean)
	const sections = []
	let cur = { agents: [], rules: [] }
	for (const l of lines) {
		const [k, ...vparts] = l.split(':')
		if (!k) continue
		const key = k.trim().toLowerCase()
		const value = vparts.join(':').trim()
		if (key === 'user-agent') {
			if (cur.agents.length || cur.rules.length) { sections.push(cur); cur = { agents: [], rules: [] } }
			cur.agents.push(value.toLowerCase())
		} else if (key === 'disallow' || key === 'allow') {
			cur.rules.push({ type: key, path: value })
		} else if (key === 'crawl-delay') {
			cur.rules.push({ type: 'crawl-delay', value: Number(value) || 0 })
		}
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
	let best = null
	let bestLen = -1
	for (const r of rules) {
		if (!r.path) continue
		if (path.startsWith(r.path)) {
			const len = r.path.length
			if (len > bestLen) { bestLen = len; best = r }
		}
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
	} catch (e) {
		return { allowed: true, crawlDelay: null }
	}
}


async function handleJob(job) {
	const { id, url } = job
	console.log('processing', id, url)
	try {
		// robots.txt check
		const { allowed, crawlDelay } = await isUrlAllowed(url)
		if (!allowed) {
			console.log('disallowed by robots:', url)
			await fetch(`${API_BASE}/indexer/${id}/error`, {
				method: 'POST',
				headers: { ...authHeaders(), 'Content-Type': 'application/json' },
				body: JSON.stringify({ id, url, error: 'disallowed_by_robots' })
			})
			return
		}

		// honor crawl-delay per-origin
		try {
			const u = new URL(url)
			const origin = u.origin
			const now = Date.now()
			const last = lastAccess.get(origin) || 0
			const delayMs = (crawlDelay && Number(crawlDelay) > 0) ? Number(crawlDelay) * 1000 : 0
			if (delayMs > 0 && now - last < delayMs) {
				await new Promise(r => setTimeout(r, delayMs - (now - last)))
			}
			lastAccess.set(origin, Date.now())
		} catch (e) {
			// ignore crawl-delay errors
		}

		const res = await timeoutFetch(url, { method: 'GET', headers: { 'User-Agent': 'kse-indexer/1.0' } })
		if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`)
		const html = await res.text()
		const head = parseHead(html)
		const payload = { url, title: head.title, description: head.description, content: head.content, lang: head.lang, fetched_at: new Date().toISOString() }
		await sendResult(id, url, payload)
		console.log('sent result for', id)
	} catch (err) {
		console.error('job error', id, err.message)
		try {
			await fetch(`${API_BASE}/indexer/${id}/error`, {
				method: 'POST',
				headers: { ...authHeaders(), 'Content-Type': 'application/json' },
				body: JSON.stringify({ id, url, error: String(err) })
			})
		} catch (e) {
			console.error('failed to report error to API', e.message)
		}
	}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function workerLoop(workerId) {
	console.log(`worker ${workerId} started`)
	while (true) {
		try {
			const job = await claimJob()
			if (!job) {
				await sleep(POLL_INTERVAL)
				continue
			}
			await handleJob(job)
		} catch (err) {
			console.error(`worker ${workerId} error`, err.message)
			await sleep(POLL_INTERVAL)
		}
	}
}

async function mainLoop() {
	console.log('indexer started; polling', API_BASE, 'workers=', CONCURRENCY)
	const workers = []
	for (let i = 0; i < CONCURRENCY; i++) workers.push(workerLoop(i))
	await Promise.all(workers)
}

if (import.meta.main) mainLoop()

