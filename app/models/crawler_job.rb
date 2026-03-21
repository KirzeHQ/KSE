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
