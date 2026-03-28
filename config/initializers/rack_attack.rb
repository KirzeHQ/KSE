require "rack/attack"

class Rack::Attack
  # Use Rails cache so limits work across processes
  Rack::Attack.cache.store = Rails.cache

  # Throttle search requests by account token (authenticated): 50 requests/minute
  throttle("search/account", limit: 50, period: 1.minute) do |req|
    next unless req.path == "/api/v1/search" && req.get?
    auth = req.get_header("HTTP_AUTHORIZATION").to_s
    if auth.present? && auth.start_with?("Bearer ")
      token = auth.split(" ", 2).last
      account = Account.find_by(api_token: token)
      account&.id
    end
  end

  # Throttle search requests by IP when not authenticated: 20 requests/minute
  throttle("search/ip", limit: 20, period: 1.minute) do |req|
    next unless req.path == "/api/v1/search" && req.get?
    auth = req.get_header("HTTP_AUTHORIZATION").to_s
    # if auth present and valid we skip ip throttle (acc throttle applies)
    if auth.present? && auth.start_with?("Bearer ")
      token = auth.split(" ", 2).last
      acct = Account.find_by(api_token: token)
      next if acct
    end
    req.ip
  end

  # Custom response for throttled requests (JSON)
  self.throttled_responder = lambda do |env|
    match_data = env["rack.attack.match_data"] || {}
    retry_after = (match_data[:period] || 60)

    body = { error: "Rate limit exceeded", retry_after: retry_after }
    [ 429, { "Content-Type" => "application/json", "Retry-After" => retry_after.to_s }, [ body.to_json ] ]
  end
end

# Ensure Rack::Attack is inserted into the middleware stack
Rails.application.config.middleware.use Rack::Attack
