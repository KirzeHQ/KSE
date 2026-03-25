# KSE

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

```bash
# Clear containers, volumes, and images (be careful with this one!)
docker compose down -v --rmi all

# Migrate db
docker compose exec api rails db:migrate


# Regenerate db/schema.rb (runs compatible migrations in a temporary SQLite DB)
# Skips Postgres-specific migrations (GIN indexes, CONCURRENTLY, extensions)
docker compose exec api bin/rails db:regenerate_schema

# Regenerate db/schema.rb using a temporary Postgres Docker container
docker compose exec api bash -lc "USE_TEMP_PG=1 bin/rails db:regenerate_schema"

# Regenerate schema from the current DB (use with care)
docker compose exec api bash -lc "USE_CURRENT_DB=1 bin/rails db:regenerate_schema"

# Run a Rails console
docker compose exec api rails console
```