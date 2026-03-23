# README

Note: We do not use kamal.

## Deployment

This project uses Ruby v3.4.2 and Rails v8.1.2

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

4. Access the api at `http://localhost:3000`
5. Access the website at `http://localhost:8080`

### Not Using Docker

Goodluck man, its all you on this,  
Just to help, follow the development instructions below,  
but make sure to set up your database and environment variables correctly.  
Also, make sure to have PostgreSQL installed and running on your machine.  
I dont know how you would do that tho.  
One more thing, i feel you, i hate docker, but just use it bro 😭

### Development

1. Install dependencies:

```bash
bundle install
```

2. Set up the database:

```bash
rails db:create && rails db:migrate
```

3. Start the Rails server:

```bash
rails server
```

### Development with Docker

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