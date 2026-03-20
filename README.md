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

```bash
docker compose exec web rails db:migrate
```

4. Access the application at `http://localhost:3000`

### Not Using Docker

Goodluck man, its all you on this,  
Just to help, follow the development instructions below,  
but make sure to set up your database and environment variables correctly.  
Also, make sure to have PostgreSQL installed and running on your machine.  
I dont know how you would do that tho.  

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