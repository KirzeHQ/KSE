class Api::V1::IndexerController < Api::BaseController
  before_action :require_api_key!, only: [ :next, :submit, :result, :error ]
  # POST /api/v1/indexer/next
  def next
    worker = extract_worker
    job = IndexerJob.claim_next!(worker)
    if job
      render json: { id: job.id, url: job.url }
    else
      head :no_content
    end
  end

  # POST /api/v1/indexer/:id/result
  # Expects application/octet-stream body containing JSON
  def result
    raw = request.raw_post.to_s
    parsed = begin
      JSON.parse(raw)
    rescue JSON::ParserError
      nil
    end

    text_index = if parsed
      JSON.pretty_generate(parsed)
    else
      raw.presence || params.to_unsafe_h.except(:controller, :action, :id).to_json
    end

    # avoid spamming logs with large payloads
    if Rails.logger.respond_to?(:silence)
      Rails.logger.silence { SearchBlob.create!(key: "indexer:#{params[:id]}:result", source: "indexer", job_id: params[:id].to_i, content_type: request.content_type, data: raw.b, text_index: text_index) }
    else
      SearchBlob.create!(key: "indexer:#{params[:id]}:result", source: "indexer", job_id: params[:id].to_i, content_type: request.content_type, data: raw.b, text_index: text_index)
    end
    render json: { ok: true }
  end

  # POST /api/v1/indexer/:id/error
  def error
    payload = request.raw_post.to_s
    text_index = begin
      JSON.pretty_generate(JSON.parse(payload))
    rescue StandardError
      payload.presence || params.to_unsafe_h.except(:controller, :action, :id).to_json
    end

    # avoid spamming logs with large payloads
    if Rails.logger.respond_to?(:silence)
      Rails.logger.silence { SearchBlob.create!(key: "indexer:#{params[:id]}:error", source: "indexer", job_id: params[:id].to_i, content_type: request.content_type, data: payload.b, text_index: text_index) }
    else
      SearchBlob.create!(key: "indexer:#{params[:id]}:error", source: "indexer", job_id: params[:id].to_i, content_type: request.content_type, data: payload.b, text_index: text_index)
    end
    render json: { ok: true }, status: :accepted
  end

  # PATCH /api/v1/indexer/submit
  # Accepts application/octet-stream (.bin) containing JSON: { items: [ { id: <job_id>, discovered: [urls] }, ... ] }
  def submit
    payload = request.raw_post.to_s.b

    url_count = 0
    begin
      parsed = JSON.parse(payload) rescue nil
      if parsed.is_a?(Hash) && parsed["items"]
        Array(parsed["items"]).each do |it|
          url_count += (it["discovered"] || it[:discovered] || []).length
        end
      end
    rescue StandardError
      url_count = 0
    end

    submission = nil
    # avoid logging large binary payload contents
    if Rails.logger.respond_to?(:silence)
      Rails.logger.silence { submission = IndexSubmission.create!(api_key: @api_key, content_type: request.content_type, url_count: url_count, data: payload) }
    else
      submission = IndexSubmission.create!(api_key: @api_key, content_type: request.content_type, url_count: url_count, data: payload)
    end

    begin
      parsed = JSON.parse(payload) rescue nil
      if parsed.is_a?(Hash)
        items = parsed["items"] || []
        Array(items).each do |it|
          id = it["id"] || it[:id]
          next unless id
          discovered = it["discovered"] || it[:discovered] || []
          text_index = begin
            JSON.pretty_generate(discovered)
          rescue StandardError
            discovered.to_json
          end
          # discovered lists are small but still avoid logging raw data
          if Rails.logger.respond_to?(:silence)
            Rails.logger.silence { SearchBlob.create!(key: "indexer:#{id}:discovered", source: "indexer", job_id: id.to_i, content_type: request.content_type, data: discovered.to_json.b, text_index: text_index) }
          else
            SearchBlob.create!(key: "indexer:#{id}:discovered", source: "indexer", job_id: id.to_i, content_type: request.content_type, data: discovered.to_json.b, text_index: text_index)
          end
          begin
            job = IndexerJob.find_by(id: id)
            job.update!(state: "completed") if job
          rescue StandardError => e
            Rails.logger.debug("Failed marking indexer job #{id} completed: #{e.class} #{e.message}")
          end
        end
      end
    rescue StandardError
      # ignore parsing errors - payload still stored
    end

    # For binary payloads (or when client indicates X-URL-Count), process async
    begin
      if request.content_type == "application/octet-stream" || request.headers["X-URL-Count"].present?
        ProcessIndexSubmissionJob.perform_later(submission.id)
      end
    rescue StandardError => e
      Rails.logger.error("Failed to enqueue processing job for IndexSubmission #{submission&.id.inspect}: #{e.class} #{e.message}")
    end

    render json: { ok: true }, status: :accepted
  end

  private

  def ensure_tmp
  end

  def extract_worker
    auth = request.headers["Authorization"]
    if auth.present? && auth.start_with?("Bearer ")
      return auth.split(" ", 2).last
    end
    request.remote_ip
  end

  def parse_json_or_params
    raw = request.raw_post.to_s
    return JSON.parse(raw) if raw.present?
    params.to_unsafe_h.except(:controller, :action, :id)
  rescue JSON::ParserError
    { raw: raw }
  end

  def require_api_key!
    auth = request.headers["Authorization"].to_s
    if auth.present? && auth.start_with?("Bearer ")
      token = auth.split(" ", 2).last
      @api_key = ApiKey.find_by(token: token)
    end

    unless @api_key && !@api_key.revoked && @api_key.indexer?
      render json: { error: "Unauthorized" }, status: :unauthorized
      nil
    end
  end
end
