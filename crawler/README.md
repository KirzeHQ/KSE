Crawler
=======

A small Bun-based crawler that claims jobs from the API, fetches pages, discovers links and apex sitemaps, and PATCHes discovered URLs back to the API.

Env
- Copy `example.env` to `.env` and fill `API_BASE` and `API_KEY`.

Install

```bash
cd crawler
bun install
bun add node-html-parser
```

Run

```bash
cp example.env .env
# edit .env
bun run index.js
```

API contract (expected)
- `POST ${API_BASE}/crawler/next` -> claims a job, returns JSON `{ id, url }` or `204 No Content` when none
- `PATCH ${API_BASE}/crawler/:id` with JSON `{ id, discovered: ["https://...", ...] }` to submit discovered links
- `POST ${API_BASE}/crawler/:id/error` to report errors

Notes
- Respects `robots.txt` for `ksebot` and falls back to `*` rules.
- Attempts to fetch `https://<origin>/sitemap.xml` to discover additional URLs.
- `CONCURRENCY` controls worker count.
