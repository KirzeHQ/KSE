# API

This is the api for the project.

## Endpoints

- `POST /register`: Register a new scraper and receive an ID and API key.
- `PATCH /submit`: Submit scraped data with scraper ID and API key.
- `GET /search`: Search for data across all sources with query parameters.
- `GET /sources`: List all sources being scraped.
- `GET /scrapes`: List recent scrapes for a specific source.
- `GET /scrapes/{source}`: Get all scrapes for a specific source.
- `GET /scrapes/{source}/{date}`: Get scrapes for a specific source on a specific date.
- `GET /queue`: Get the current scraping queue and assigned scrapers.
- `GET /trusted-scrapers`: List all trusted scrapers and their assigned sources.
- `GET /hot-storage`: List all data currently in hot storage.
- `GET /cold-storage`: List all data currently in cold storage.
- `GET /scraper/{id}/stats`: Get statistics about a specific scraper's performance and reliability.
- `GET /scraper/{id}/history`: Get the history of scrapes submitted by a specific scraper.
- `GET /scraper/{id}/trust-level`: Get the current trust level of a specific scraper
- `GET /scraper/{id}/assigned-sources`: Get the list of sources currently assigned to a specific scraper.

## Authentication

- Scrapers must include their API key in the `Authorization` header for all requests.
- API keys are issued upon registration and can be revoked by the maintainers if necessary.
- In future we will have a dashboard for this but for now you can contact us to manage your API key.

## Data Format

- Scraped data should be serialized in a binary format (`.bin`) for efficient storage and retrieval.
- The API will handle deserialization and storage of the data in the appropriate storage system
- Search queries return results in JSON format
- The API will also support pagination for search results and scrapes listing.

## Rate Limiting

- The API will have cors and a configurable rate limiting option

## Stack

- Rust for the API implementation
- Vercel for hosting the API
- S3-compatible storage for hot scrapes
- Github private repositories for cold scrapes
- Github Actions for automation of archival to cold storage

### Rust Crates

- **Web framework / HTTP**:
  - `axum` - routing, request/response handling
  - `hyper` - low level HTTP library

- **Data serialization**:
  - `serde` - serialization/deserialization framework
  - `bincode` - binary serialization format

- **Database / Storage**:
  - `rusoto_s3` or `aws-sdk-s3` - S3-compatible storage client (dk yet)
  - `octocrab` - GitHub API client to push to private repos (going to make a custom bot for this eventually)

- **Authentication**:
  - `jsonwebtoken` - for generating and verifying API keys
  - `bcrypt` - for hashing API keys if needed (optional)

- **Utils**:
  - `tokio` - async runtime
  - `dotenv` - for managing environment variables
  - `log` - for logging and debugging

- **Ratelimit & Cors**:
  - `tower-http` - for CORS and rate limiting middleware

- **CLI**:
  - `clap` - no shi---- Who said that? who said that? what are you doing? get out of here.