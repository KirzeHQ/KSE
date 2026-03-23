Rails.application.config.after_initialize do
  send_from = ENV.fetch("SEND_FROM", ENV.fetch("MAIL_NAME", "noreply@example.com"))
  send_from_name = ENV["SEND_FROM_NAME"].to_s
  ActionMailer::Base.default_options = { from: send_from_name.present? ? "#{send_from_name} <#{send_from}>" : send_from }

  ActionMailer::Base.smtp_settings = {
    address: ENV.fetch("SMTP_ADDRESS", "smtp.gmail.com"),
    port: ENV.fetch("SMTP_PORT", 587).to_i,
    domain: ENV.fetch("SMTP_DOMAIN", "example.com"),
    user_name: send_from,
    password: ENV["MAIL_PASSWORD"],
    authentication: :plain,
    enable_starttls_auto: true
  }
end
