# == Schema Information
#
# Table name: crawler_jobs
#
#  id         :bigint           not null, primary key
#  claimed_at :datetime
#  claimed_by :string
#  last_error :text
#  payload    :json
#  state      :string           default("pending"), not null
#  url        :string           not null
#  created_at :datetime         not null
#  updated_at :datetime         not null
#
# Indexes
#
#  index_crawler_jobs_on_claimed_at  (claimed_at)
#  index_crawler_jobs_on_state       (state)
#
class CrawlerJob < ApplicationRecord
  scope :pending, -> { where(state: "pending") }

  def self.claim_next!(worker = nil)
    transaction do
      job = pending.lock.order(:created_at).first
      return nil unless job
      job.update!(state: "claimed", claimed_at: Time.current, claimed_by: worker)
      job
    end
  end
end
