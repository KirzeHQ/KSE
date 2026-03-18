# Scraper

Here you can find the scraper codebase and configuration file.  
Running the scraper will automatically get an API key and ID from the API and start scraping assigned websites.  
In the future there will be an account system to link your scrapers to your account and track your contributions.  

## What the scraper submits

The scraper now submits a minimal JSON payload per page containing the fields the indexer needs. Fields included:

- `url` — fetched URL (string)
- `title` — page title (string)
- `canonical` — canonical URL if present, otherwise `url` (string)
- `outlinks_count` — number of discovered outbound HTTP(S) links (number)
- `lang` — detected language from `<html lang>` or `Content-Language` (string)
- `description` — `<meta name="description">` (string)
- `status` — HTTP status code from the fetch (number)
- `fetches` — number of times this page has been fetched (number, scraper sets `1`)
- `content_hash` — SHA-256 hex of the raw HTML (string)

This keeps the payload compact while providing the metadata needed for indexing. See `index.js` for the exact extraction code.

## Configuring the scraper (`.scraper.json`)

The scraper reads and persists its runtime config in `.scraper.json` in the scraper folder. Put any site seeds and runtime limits under `config`.

Example `.scraper.json`:

{
	"config": {
		"seeds": [
			"https://example.com",
			"https://another.example"
		],
		"max_pages": 200,
		"max_depth": 3,
		"concurrency": 5,
		"continuous": true,
		"poll_interval_seconds": 600,
		"revisit_after_seconds": 86400,
		"ram_limit_mb": 512,
		"cpu_ops_per_sec": 5
	}
}

- `seeds`: array of seed URLs the crawler should start from (required to override defaults).
- `ram_limit_mb`: optional integer to request a soft memory limit in MB; when exceeded the crawler will pause briefly.
- `cpu_ops_per_sec`: optional integer to throttle request rate (approx requests per second) to reduce CPU usage.

