Rails.application.config.after_initialize do
  send_from = ENV.fetch("SEND_FROM", ENV.fetch("MAIL_NAME", "noreply@example.com"))
  send_from_name = ENV["SEND_FROM_NAME"].to_s
  ActionMailer::Base.default_options = { from: send_from_name.present? ? "#{send_from_name} <#{send_from}>" : send_from }

  smtp_address = ENV.fetch("SMTP_ADDRESS", "smtp.gmail.com")
  smtp_port = ENV.fetch("SMTP_PORT", 587).to_i
  smtp_domain = ENV.fetch("SMTP_DOMAIN", "example.com")
  smtp_user = send_from
  smtp_password = ENV["MAIL_PASSWORD"]
  smtp_auth = (ENV["SMTP_AUTHENTICATION"] || "plain").to_sym

  use_ssl = if ENV.key?("SMTP_SSL")
    ENV["SMTP_SSL"].to_s.downcase == "true"
  else
    smtp_port == 465
  end

  enable_starttls = if ENV.key?("SMTP_ENABLE_STARTTLS")
    ENV["SMTP_ENABLE_STARTTLS"].to_s.downcase == "true"
  else
    !use_ssl
  end

  ActionMailer::Base.smtp_settings = {
    address: smtp_address,
    port: smtp_port,
    domain: smtp_domain,
    user_name: smtp_user,
    password: smtp_password,
    authentication: smtp_auth,
    enable_starttls_auto: enable_starttls
  }

  # If implicit SSL requested, set the SSL flag and disable STARTTLS
  if use_ssl
    ActionMailer::Base.smtp_settings[:ssl] = true
    ActionMailer::Base.smtp_settings[:enable_starttls_auto] = false
  end

  if ENV["SMTP_OPENSSL_VERIFY_MODE"].present?
    ActionMailer::Base.smtp_settings[:openssl_verify_mode] = ENV["SMTP_OPENSSL_VERIFY_MODE"]
  end
end
