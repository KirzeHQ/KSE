Rails.application.config.after_initialize do
  smtp = {
    address: ENV.fetch("SMTP_ADDRESS", "smtp.gmail.com"),
    port: ENV.fetch("SMTP_PORT", 587).to_i,
    domain: ENV.fetch("SMTP_DOMAIN", "example.com"),
    user_name: (ENV["SMTP_USER"] || ENV["SEND_FROM"] || ENV["MAIL_NAME"]),
    password: ENV["MAIL_PASSWORD"],
    authentication: (ENV["SMTP_AUTHENTICATION"] || "plain").to_sym,
    enable_starttls_auto: (ENV.key?("SMTP_ENABLE_STARTTLS") ? ENV["SMTP_ENABLE_STARTTLS"].to_s.downcase == "true" : true)
  }

  # Implicit SSL (SMTPS) when using port 465 or when explicitly requested.
  if (ENV["SMTP_SSL"] || smtp[:port] == 465).to_s.downcase == "true" || smtp[:port] == 465
    smtp[:ssl] = true
    smtp[:enable_starttls_auto] = false
  end

  smtp[:openssl_verify_mode] = ENV["SMTP_OPENSSL_VERIFY_MODE"] if ENV["SMTP_OPENSSL_VERIFY_MODE"].present?

  ActionMailer::Base.smtp_settings = smtp
  ActionMailer::Base.delivery_method = (ENV.fetch("MAIL_DELIVERY_METHOD", "smtp")).to_sym
end
