class Api::V1::CrawlerController < Api::BaseController
  before_action :require_api_key!, only: [ :next, :batch, :update, :error ]

  # POST /api/v1/crawler/next
  def next
    worker = extract_worker
    job = CrawlerJob.claim_next!(worker)
    if job
      render json: { id: job.id, url: job.url }
    else
      head :no_content
    end
  end

  # PATCH /api/v1/crawler/:id
  def update
    payload = request.raw_post.to_s

    text_index = begin
      JSON.pretty_generate(JSON.parse(payload))
    rescue StandardError
      payload.presence || params.to_unsafe_h.except(:controller, :action, :id).to_json
    end

    SearchBlob.create!(key: "crawler:#{params[:id]}:discovered", source: "crawler", job_id: params[:id].to_i, content_type: request.content_type, data: payload.b, text_index: text_index)
    render json: { ok: true }
  end

  # POST /api/v1/crawler/:id/error
  def error
    payload = request.raw_post.to_s
    text_index = begin
      JSON.pretty_generate(JSON.parse(payload))
    rescue StandardError
      payload.presence || params.to_unsafe_h.except(:controller, :action, :id).to_json
    end

    SearchBlob.create!(key: "crawler:#{params[:id]}:error", source: "crawler", job_id: params[:id].to_i, content_type: request.content_type, data: payload.b, text_index: text_index)
    render json: { ok: true }, status: :accepted
  end

  # POST /api/v1/crawler/batch
  # Accepts JSON: { items: [ { id: <job_id>, discovered: [urls] } , ... ] }
  def batch
    payload = parse_json_or_params
    items = if payload.is_a?(Array)
      payload
    else
      payload[:items] || payload["items"] || []
    end

    items = Array(items)
    items.each do |it|
      id = it["id"] || it[:id]
      next unless id

      if it.key?("error") || it.key?(:error)
        err = it["error"] || it[:error]
        text_index = begin
          JSON.pretty_generate(err)
        rescue StandardError
          err.to_s
        end
        SearchBlob.create!(key: "crawler:#{id}:error", source: "crawler", job_id: id.to_i, content_type: request.content_type, data: err.to_s.b, text_index: text_index)
      else
        discovered = it["discovered"] || it[:discovered] || []
        text_index = begin
          JSON.pretty_generate(discovered)
        rescue StandardError
          discovered.to_json
        end
        SearchBlob.create!(key: "crawler:#{id}:discovered", source: "crawler", job_id: id.to_i, content_type: request.content_type, data: discovered.to_json.b, text_index: text_index)
      end

      begin
        job = CrawlerJob.find_by(id: id)
        job.update!(state: "completed") if job
      rescue StandardError => e
        Rails.logger.debug("Failed to mark job #{id} completed: #{e.class} #{e.message}")
      end
    end

    render json: { ok: true }, status: :accepted
  end

  private

  def require_api_key!
    auth = request.headers["Authorization"].to_s
    if auth.present? && auth.start_with?("Bearer ")
      token = auth.split(" ", 2).last
      @api_key = ApiKey.find_by(token: token)
    end

    unless @api_key && !@api_key.revoked && @api_key.crawler?
      render json: { error: "Unauthorized" }, status: :unauthorized
    end
  end

  def extract_worker
    return "api_key:#{@api_key.id}" if @api_key
    request.remote_ip
  end

  def ensure_tmp
  end

  def parse_json_or_params
    raw = request.raw_post.to_s
    return JSON.parse(raw) if raw.present?
    params.to_unsafe_h.except(:controller, :action, :id)
  rescue JSON::ParserError
    { raw: raw }
  end
end
