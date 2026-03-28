FROM ruby:3.4.2

WORKDIR /app

# Install system dependencies
RUN apt-get update -qq && apt-get install -y \
    build-essential libpq-dev nodejs

# Copy Gemfiles first
COPY Gemfile Gemfile.lock ./

# Install bundler
RUN gem install bundler -v "$(grep -A 1 'BUNDLED WITH' Gemfile.lock | tail -n 1)"

# 
RUN bundle config set --local path 'vendor/bundle' \
 && bundle install --jobs 4 --retry 3

# Copy app code
COPY . .

EXPOSE 3000

CMD ["bundle", "exec", "rails", "s", "-b", "0.0.0.0", "-p", "3000"]