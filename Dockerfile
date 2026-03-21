FROM ruby:3.4

WORKDIR /app

# Install system dependencies
RUN apt-get update -qq && apt-get install -y \
    build-essential libpq-dev nodejs

# Copy Gemfiles first
COPY Gemfile ./

# Install gems
RUN bundle install

# Copy app code
COPY . .

EXPOSE 3000

CMD ["bundle", "exec", "rails", "s", "-b", "0.0.0.0", "-p", "3000"]