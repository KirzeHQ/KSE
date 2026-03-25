# == Schema Information
#
# Table name: accounts
#
#  id                   :bigint           not null, primary key
#  api_token            :string
#  confirmation_sent_at :datetime
#  confirmation_token   :string
#  confirmed_at         :datetime
#  created_at           :datetime         not null
#  email                :string           not null
#  github_uid           :string
#  name                 :string
#  password_digest      :string
#  updated_at           :datetime         not null
#
# Indexes
#
#  index_accounts_on_api_token           (api_token) UNIQUE
#  index_accounts_on_confirmation_token  (confirmation_token) UNIQUE
#  index_accounts_on_email               (email) UNIQUE
#  index_accounts_on_github_uid          (github_uid) UNIQUE
#
class Account < ApplicationRecord
  has_many :api_keys, dependent: :destroy
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
