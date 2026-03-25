class IndexSubmission < ApplicationRecord
  belongs_to :api_key, optional: true

  validates :data, presence: true
  validates :url_count, numericality: { greater_than_or_equal_to: 0 }
end
