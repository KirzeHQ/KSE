# == Schema Information
#
# Table name: index_submissions
#
#  id           :bigint           not null, primary key
#  content_type :string
#  data         :binary
#  processed_at :datetime
#  url_count    :integer          default(0), not null
#  created_at   :datetime         not null
#  updated_at   :datetime         not null
#  api_key_id   :bigint
#
# Indexes
#
#  index_index_submissions_on_api_key_id  (api_key_id)
#
# Foreign Keys
#
#  fk_rails_...  (api_key_id => api_keys.id)
#
class IndexSubmission < ApplicationRecord
  belongs_to :api_key, optional: true

  validates :data, presence: true
  validates :url_count, numericality: { greater_than_or_equal_to: 0 }
end
