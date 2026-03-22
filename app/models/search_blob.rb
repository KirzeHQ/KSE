class SearchBlob < ApplicationRecord
  include PgSearch::Model

  pg_search_scope :full_text_search,
                  against: :text_index,
                  associated_against: {},
                  using: { tsearch: { dictionary: "english", prefix: true } },
                  ignoring: :accents

  validates :key, presence: true

  # convenience for attaching to jobs
  def job
    if source == "crawler"
      CrawlerJob.find_by(id: job_id)
    elsif source == "indexer"
      IndexerJob.find_by(id: job_id)
    else
      nil
    end
  end

  def url
    job&.url
  end
end
