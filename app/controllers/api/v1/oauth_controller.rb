require "net/http"
require "uri"
require "json"

class Api::V1::OauthController < Api::BaseController
  # GET /api/v1/acc/oauth/github
  def github
    client_id = ENV["GITHUB_CLIENT_ID"]
    return render json: { error: "GitHub OAuth not configured" }, status: :service_unavailable if client_id.blank?

    redirect_uri = ENV["GITHUB_REDIRECT_URI"].presence || (request.base_url + "/api/v1/acc/oauth/github/callback")
    state = SecureRandom.hex(24)
    cookies.encrypted[:github_oauth_state] = { value: state, httponly: true, secure: Rails.env.production? }

    auth_url = URI::HTTPS.build(host: "github.com", path: "/login/oauth/authorize", query: URI.encode_www_form(client_id: client_id, redirect_uri: redirect_uri, scope: "user:email", state: state))
    redirect_to auth_url.to_s
  end

  # GET /api/v1/acc/oauth/github/callback
  def github_callback
    code = params[:code].to_s
    state = params[:state].to_s
    stored = cookies.encrypted[:github_oauth_state]

    if stored.present? && stored != state
      return render plain: "Invalid OAuth state", status: :unauthorized
    end

    token_data = exchange_github_code_for_token(code)
    access_token = token_data && token_data["access_token"]
    return render plain: "OAuth token exchange failed", status: :bad_request unless access_token

    github_user = fetch_github_user(access_token)
    email = github_user["email"]
    if email.blank?
      emails = fetch_github_emails(access_token) rescue []
      primary = emails.find { |e| e["primary"] && e["verified"] } || emails.find { |e| e["verified"] }
      email = primary && primary["email"]
    end

    account = nil
    if github_user["id"]
      account = Account.find_by(github_uid: github_user["id"].to_s)
    end

    if account.nil? && email.present?
      account = Account.find_by(email: email)
      if account && account.github_uid.blank?
        account.update!(github_uid: github_user["id"].to_s)
      end
    end

    if account.nil?
      generated_email = email.presence || "github-#{github_user['id']}@local.invalid"
      account = Account.create!(email: generated_email, name: (github_user["name"].presence || github_user["login"]), password: SecureRandom.hex(16))
      account.update!(confirmed_at: Time.current) if account.respond_to?(:confirm!)
      account.update!(github_uid: github_user["id"].to_s)
    end

    account.regenerate_api_token!

    frontend = ENV.fetch("FRONTEND_URL", nil)
    redirect_path = frontend ? "#{frontend}/acc/oauth_callback?secret=#{account.api_token}" : "/acc/oauth_callback?secret=#{account.api_token}"
    redirect_to redirect_path
  rescue StandardError => e
    Rails.logger.error("GitHub OAuth error: "+e.message)
    render plain: "OAuth error", status: :internal_server_error
  end

  private

  def exchange_github_code_for_token(code)
    uri = URI("https://github.com/login/oauth/access_token")
    req = Net::HTTP::Post.new(uri)
    req["Accept"] = "application/json"
    req.set_form_data(
      client_id: ENV["GITHUB_CLIENT_ID"],
      client_secret: ENV["GITHUB_CLIENT_SECRET"],
      code: code,
      redirect_uri: ENV["GITHUB_REDIRECT_URI"].presence || (request.base_url + "/api/v1/acc/oauth/github/callback")
    )
    res = Net::HTTP.start(uri.hostname, uri.port, use_ssl: true) { |http| http.request(req) }
    JSON.parse(res.body || "{}")
  end

  def fetch_github_user(token)
    uri = URI("https://api.github.com/user")
    req = Net::HTTP::Get.new(uri)
    req["Authorization"] = "token #{token}"
    req["User-Agent"] = "KSE"
    res = Net::HTTP.start(uri.hostname, uri.port, use_ssl: true) { |http| http.request(req) }
    JSON.parse(res.body || "{}")
  end

  def fetch_github_emails(token)
    uri = URI("https://api.github.com/user/emails")
    req = Net::HTTP::Get.new(uri)
    req["Authorization"] = "token #{token}"
    req["User-Agent"] = "KSE"
    res = Net::HTTP.start(uri.hostname, uri.port, use_ssl: true) { |http| http.request(req) }
    JSON.parse(res.body || "[]")
  end
end
