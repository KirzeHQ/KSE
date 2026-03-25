class ApiKey < ApplicationRecord
  belongs_to :account

  enum :kind, { crawler: 0, indexer: 1 }

  validates :token, presence: true, uniqueness: true

  before_validation :ensure_token, on: :create

  def ensure_token
    self.token ||= SecureRandom.hex(32)
  end
end
