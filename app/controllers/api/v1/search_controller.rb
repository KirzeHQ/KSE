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
        rec = {
          type: "blob",
          id: b.id,
          key: b.key,
          source: b.source,
          job_id: b.job_id,
          url: nil,
          title: nil,
          description: nil,
          sitename: nil,
          crawl_date: nil,
          status_code: nil,
          snippet: (b.text_index || "")[0..500]
        }

        if b.data.present?
          begin
            parsed = JSON.parse(b.data.force_encoding("UTF-8")) rescue nil
            if parsed.is_a?(Hash)
              rec[:url] = parsed["url"] || parsed["u"] || rec[:url]
              rec[:title] = parsed["title"] || parsed["t"] || rec[:title]
              rec[:description] = parsed["description"] || parsed["desc"] || rec[:description]
              rec[:sitename] = parsed["sitename"] || parsed["site"] || rec[:sitename]
              if parsed["crawl_date"]
                cd = parsed["crawl_date"].to_i
                cd = cd / 1000 if cd > 10_000_000_000
                rec[:crawl_date] = Time.at(cd).utc.iso8601 rescue nil
              end
              rec[:status_code] = parsed["status_code"] if parsed.key?("status_code")
            end
          rescue StandardError
          end
        end

        rec[:url] ||= b.url
        results << rec
      end
    end

    # Decide response format: default to binary (.bin) unless JSON explicitly requested
    accept = request.headers["Accept"].to_s
    want_json = params[:format].to_s.downcase == "json" || accept.include?("application/json")

    unless want_json
      # encode only the blob results (type == 'blob') into .bin
      blob_records = []
      results.each do |r|
        next unless r[:type] == "blob"
        blob = SearchBlob.find_by(id: r[:id])
        rec = { url: nil, title: "", content: "", description: "", sitename: "", crawl_date: nil, status_code: 0, outlinks: [] }
        if blob
          begin
            if blob.data.present?
              parsed = JSON.parse(blob.data.force_encoding("UTF-8")) rescue nil
              if parsed.is_a?(Hash)
                rec[:url] = parsed["url"] || parsed["u"] || r[:url]
                rec[:title] = parsed["title"] || ""
                rec[:content] = parsed["content"] || ""
                rec[:description] = parsed["description"] || ""
                rec[:sitename] = parsed["sitename"] || ""
                rec[:crawl_date] = parsed["crawl_date"] ? Time.at(parsed["crawl_date"].to_i / 1000.0) : nil
                rec[:status_code] = parsed["status_code"] || 0
                rec[:outlinks] = parsed["outlinks"] || []
              end
            end
          rescue StandardError
          end
        end
        # fallbacks
        rec[:url] ||= r[:url] || ""
        rec[:title] = r[:snippet] || rec[:title] || ""
        blob_records << rec
      end

      bin = BinRecordEncoder.encode_batch(blob_records)
      response.headers["X-URL-Count"] = blob_records.length.to_s
      send_data bin, type: "application/octet-stream", disposition: "attachment; filename=search_#{Time.now.to_i}.bin"
      return
    end

    render json: { results: results, page: page, per_page: per }
  end
end
