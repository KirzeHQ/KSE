class AccountsMailer < ApplicationMailer
  def welcome
    @account = params[:account]
    mail(to: @account.email, subject: "Welcome to KSE")
  end

  def confirmation
    @account = params[:account]
    @token = params[:token]
    @confirm_url = params[:confirm_url]
    mail(to: @account.email, subject: "Confirm your email")
  end

  def generic_email
    @body = params[:body]
    mail(to: params[:to], subject: params[:subject] || "Message from KSE")
  end
end
