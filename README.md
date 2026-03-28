# KSE


## Optimizations

## Stored tsvector column and GIN index for full-text search

To improve full-text search performance, implemented a stored tsvector column and a GIN index:

- **Stored tsvector column (`text_search`)**: adds a precomputed `tsvector` to `search_blobs`, avoiding recomputing text on every query and reducing CPU during searches and indexes.
- **GIN index on `text_search`**: a GIN index created concurrently speeds up full-text queries.
- **Unaccent + trigger**: a trigger function populates `text_search` using `unaccent(...)` so searches that ignore accents (pg_search `ignoring: :accents`) can use the index.
- **PgSearch integration**: `SearchBlob` is configured to use the stored `text_search` tsvector so queries leverage the GIN index.

How to verify:

```bash
# run migrations
bin/rails db:migrate

# list indexes for search_blobs
bin/rails runner "p ActiveRecord::Base.connection.indexes('search_blobs').map(&:name)"

# Run EXPLAIN ANALYZE in psql or via bin/rails dbconsole to confirm index usage:
EXPLAIN ANALYZE
SELECT id, ts_rank(text_search, to_tsquery('english','flavortown:*')) AS rank
FROM search_blobs
WHERE text_search @@ to_tsquery('english','flavortown:*')
ORDER BY rank DESC
LIMIT 25;
```

Notes:
- Migrations are the superiour way to create the column and index, the initializer is a fallback and should not replace proper schema management.

## Deployment

This project uses Ruby v3.4.2 and Rails v8.1.2  
We dont use Kamal, we use Docker Compose for deployment and development.

### Docker

1. Build the Docker image:

```bash
docker compose build
```

2. Start the containers:

```bash
docker compose up -d
```

3. Run database migrations:

Dont do on production, dont be like me..

```bash
docker compose exec api rails db:migrate

# If docker not running:
docker compose run api bin/rails db:migrate
```

4. Access at `http://localhost:3000` (or your server's IP/domain)

### Not Using Docker

😭😭😭😭   
(someone please make a non-docker deployment guide 😭)

### Development

Run:
```
docker compose up -d
```

thats it, the development environment will be up and running.  
Access at `http://localhost:3000`

### Random Useful Commands

#### Clear docker data and start fresh
```bash
docker compose down -v --rmi all
```

#### Migrate db
```bash
# If docker is running:
docker compose exec api rails db:migrate
# If docker not running:
docker compose run api bin/rails db:migrate
```

#### Regenerate db/schema.rb
```bash
# Regenerate db/schema.rb (runs compatible migrations in a temporary SQLite DB)
# Skips Postgres-specific migrations (GIN indexes, CONCURRENTLY, extensions)
docker compose exec api bin/rails db:regenerate_schema

# Regenerate db/schema.rb using a temporary Postgres Docker container
USE_TEMP_PG=1 bin/rails db:regenerate_schema

# Regenerate schema from the current DB (use with care)
docker compose exec api bash -lc "USE_CURRENT_DB=1 bin/rails db:regenerate_schema"
```

#### Rails console
```bash
# Run a Rails console
docker compose exec api rails console
```

#### Lint code
```bash
# Run RuboCop linter
bin/rubocop -a

# Run Prettier check (indexer)
npx prettier --check "indexer/**.{js,jsx,css,scss,html}"
```

#### Our Production CMD
```bash
docker compose -f docker-compose.prod.yml up -d --remove-orphans --build
```

#### This stupid error:

api-1  | A server is already running (pid: 1, file: /app/tmp/pids/server.pid).

```bash
docker compose -f docker-compose.prod.yml run api rm -f /app/tmp/pids/server.pid
```