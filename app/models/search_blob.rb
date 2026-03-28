# == Schema Information
#
# Table name: search_blobs
#
#  id           :bigint           not null, primary key
#  content_type :string
#  data         :binary
#  key          :string           not null
#  source       :string
#  text_index   :text
#  created_at   :datetime         not null
#  updated_at   :datetime         not null
#  job_id       :integer
#
# Indexes
#
#  index_search_blobs_on_job_id       (job_id)
#  index_search_blobs_on_key          (key) UNIQUE
#  index_search_blobs_on_source       (source)
#  index_search_blobs_on_text_search  (to_tsvector('english'::regconfig, ((COALESCE(text_index, ''::text) || ' '::text) || (COALESCE(key, ''::character varying))::text))) USING gin
#
class SearchBlob < ApplicationRecord
  include PgSearch::Model

  pg_search_scope :full_text_search,
                  against: :text_index,
                  associated_against: {},
                  using: { tsearch: { dictionary: "english", prefix: true, tsvector_column: 'text_search' } },
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
