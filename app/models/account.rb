class Account < ApplicationRecord
  has_secure_password

  validates :email, presence: true, uniqueness: true
  validates :password, length: { minimum: 6 }, allow_nil: true

  def ensure_api_token!
    return api_token if api_token.present?
    update!(api_token: SecureRandom.hex(32))
    api_token
  end

  def regenerate_api_token!
    update!(api_token: SecureRandom.hex(32))
    api_token
  end

  def generate_confirmation_token!
    token = SecureRandom.hex(24)
    update!(confirmation_token: token, confirmation_sent_at: Time.current)
    token
  end

  def confirm!(time = Time.current)
    update!(confirmed_at: time, confirmation_token: nil)
  end

  def confirmed?
    confirmed_at.present?
  end
end
