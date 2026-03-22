Rails.application.config.after_initialize do
  ActionMailer::Base.default_options = { from: ENV.fetch("MAIL_NAME", "noreply@example.com") }

  ActionMailer::Base.smtp_settings = {
    address: ENV.fetch("SMTP_ADDRESS", "smtp.gmail.com"),
    port: ENV.fetch("SMTP_PORT", 587).to_i,
    domain: ENV.fetch("SMTP_DOMAIN", "example.com"),
    user_name: ENV["MAIL_NAME"],
    password: ENV["MAIL_PASSWORD"],
    authentication: :plain,
    enable_starttls_auto: true
  }
end
