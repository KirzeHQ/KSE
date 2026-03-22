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
      # use pg_search full text search on blobs (falls back to LIKE if Postgres not configured)
      blobs = if SearchBlob.respond_to?(:full_text_search)
        SearchBlob.full_text_search(q).limit(per).offset(offset)
      else
        SearchBlob.where("text_index LIKE ? OR key LIKE ?", "%#{q}%", "%#{q}%").limit(per).offset(offset)
      end

      blobs.each do |b|
        results << { type: "blob", id: b.id, key: b.key, source: b.source, job_id: b.job_id, url: b.url, snippet: (b.text_index || "")[0..500] }
      end
    end

    render json: { results: results, page: page, per_page: per }
  end
end
