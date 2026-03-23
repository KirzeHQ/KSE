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

3. Start the web container:

```bash
docker compose -f docker-compose.web.yml up -d
```

4. Run database migrations:

Dont do on production, dont be like me..

```bash
docker compose exec api rails db:migrate

# If docker not running:
docker compose run api bin/rails db:migrate
```

5.  
Access the api at `http://localhost:3000`  
Access the website at `http://localhost:8080`  

### Not Using Docker

😭😭😭😭

### Development

Run:
```
docker compose -f docker-compose.dev.yml up -d
```

website:
```
./dev.sh
```

thats it, the development environment will be up and running.  
Access the api at `http://localhost:3000`  
Access the website at `http://localhost:8080`