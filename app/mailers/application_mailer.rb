class ApplicationMailer < ActionMailer::Base
  # Use SEND_FROM / SEND_FROM_NAME for the mail 'From' header.
  send_from = ENV.fetch("SEND_FROM", ENV.fetch("MAIL_NAME", "noreply@example.com"))
  send_from_name = ENV["SEND_FROM_NAME"].to_s
  default from: (send_from_name.present? ? "#{send_from_name} <#{send_from}>" : send_from)
  layout "mailer"
end
