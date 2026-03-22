class ApplicationMailer < ActionMailer::Base
  default from: ENV.fetch("MAIL_NAME", "noreply@example.com")
  layout "mailer"
end
