class Api::V1::SearchController < Api::BaseController
  # GET /api/v1/search?q=term&type=accounts|jobs|all&page=1&per_page=25
  def index
    q = params[:q].to_s.strip
    return render json: { results: [] } if q.blank?

    type = params[:type].to_s.downcase
    page = (params[:page] || 1).to_i
    per = [ (params[:per_page] || 25).to_i, 100 ].min
    offset = (page - 1) * per

    results = []

    if type.blank? || type == "accounts" || type == "all"
      accounts = Account.where("email LIKE ? OR name LIKE ?", "%#{q}%", "%#{q}%").limit(per).offset(offset)
      accounts.each do |a|
        results << { type: "account", id: a.id, email: a.email, name: a.name }
      end
    end

    if type.blank? || type == "jobs" || type == "all"
      crawler_matches = CrawlerJob.where("url LIKE ?", "%#{q}%")
      indexer_matches = IndexerJob.where("url LIKE ?", "%#{q}%")
      combined = (crawler_matches.to_a + indexer_matches.to_a)
      slice = combined.slice(offset, per) || []
      slice.each do |j|
        results << { type: j.class.name.underscore, id: j.id, url: j.url, state: j.state }
      end
    end

    render json: { results: results, page: page, per_page: per }
  end
end
