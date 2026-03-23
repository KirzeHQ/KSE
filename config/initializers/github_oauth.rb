# Expose GitHub OAuth ENV settings via `Rails.configuration.x.github`
# Allows referencing `Rails.configuration.x.github.client_id` from other parts of the app.
Rails.application.config.x.github = ActiveSupport::OrderedOptions.new
Rails.application.config.x.github.client_id = ENV["GITHUB_CLIENT_ID"]
Rails.application.config.x.github.client_secret = ENV["GITHUB_CLIENT_SECRET"]
Rails.application.config.x.github.redirect_uri = ENV["GITHUB_REDIRECT_URI"]
