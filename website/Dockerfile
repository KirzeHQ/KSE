# Stage 1: Dev
FROM node:20-alpine AS dev
WORKDIR /app
COPY . .
RUN npm install -g live-server
EXPOSE 8080
CMD ["live-server", "--port=80", "--host=0.0.0.0", "--no-browser", "--watch=."]

# Stage 2: Production
FROM nginx:alpine AS prod
# Remove default nginx site
RUN rm -rf /usr/share/nginx/html/*
# Copy static files
COPY . /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]