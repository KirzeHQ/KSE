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

## Scraper configuration

- `api_key` (string) — optional API key used to authenticate with the API.
- `scraper_id` (string) — optional scraper identifier assigned by the API.
- `type` (string, default `crawler`) — `crawler` (submit URL-only items to the queue) or `scraper` (poll queue and fetch pages).
- `seeds` (array of strings) — seed URLs to start from.
- `max_pages` (integer) — total pages to fetch before stopping.
- `max_depth` (integer) — maximum link depth to follow.
- `concurrency` (integer) — number of simultaneous network tasks (I/O parallelism).
- `workers` (integer) — number of worker threads for CPU-bound parsing (defaults to CPU cores if omitted).
- `continuous` (boolean) — keep running and polling for work instead of exiting after the run.
- `test` (boolean) — enable test mode (short runs, extra diagnostics).
- `test_duration_seconds` (integer) — runtime in seconds when `test` is enabled.
- `mega_submit_batch_size` (integer) — number of URL-only items buffered before a single `/queue/mega-submit` POST.
- `mega_submit_interval_seconds` (integer) — background flush interval (seconds) for partial mega-batches.
- `scraped_file`, `crawler_file`, `state_file` (strings) — local filenames for runtime artifacts.