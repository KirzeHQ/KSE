class Api::V1::IndexerController < Api::BaseController
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

    SearchBlob.create!(key: "indexer:#{params[:id]}:result", source: "indexer", job_id: params[:id].to_i, content_type: request.content_type, data: raw.b, text_index: text_index)
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

    SearchBlob.create!(key: "indexer:#{params[:id]}:error", source: "indexer", job_id: params[:id].to_i, content_type: request.content_type, data: payload.b, text_index: text_index)
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
end
