FROM bun

WORKDIR /

RUN apt-get update -qq && apt-get install -y \
    bun

COPY . .

CMD ["bun", "run", "start"]