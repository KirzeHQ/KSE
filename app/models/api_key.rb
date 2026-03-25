# == Schema Information
#
# Table name: api_keys
#
#  id         :bigint           not null, primary key
#  kind       :integer          default("crawler"), not null
#  name       :string
#  revoked    :boolean          default(FALSE), not null
#  token      :string           not null
#  created_at :datetime         not null
#  updated_at :datetime         not null
#  account_id :bigint           not null
#
# Indexes
#
#  index_api_keys_on_account_id  (account_id)
#  index_api_keys_on_token       (token) UNIQUE
#
# Foreign Keys
#
#  fk_rails_...  (account_id => accounts.id)
#
class ApiKey < ApplicationRecord
  belongs_to :account

  enum :kind, { crawler: 0, indexer: 1 }

  validates :token, presence: true, uniqueness: true

  before_validation :ensure_token, on: :create

  def ensure_token
    self.token ||= SecureRandom.hex(32)
  end
end
