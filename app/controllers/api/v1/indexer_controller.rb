class Api::V1::IndexerController < Api::BaseController
  require "fileutils"

  TMP_DIR = Rails.root.join("tmp", "api", "indexer")

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
    ensure_tmp
    raw = request.raw_post.to_s
    parsed = begin
      JSON.parse(raw)
    rescue JSON::ParserError
      nil
    end

    if parsed
      File.write(TMP_DIR.join("#{params[:id]}-result.json"), JSON.pretty_generate(parsed))
    else
      # store raw bytes if not valid JSON
      File.binwrite(TMP_DIR.join("#{params[:id]}-result.bin"), raw)
    end

    render json: { ok: true }
  end

  # POST /api/v1/indexer/:id/error
  def error
    ensure_tmp
    payload = parse_json_or_params
    File.write(TMP_DIR.join("#{params[:id]}-error.json"), JSON.pretty_generate(payload))
    render json: { ok: true }, status: :accepted
  end

  private

  def ensure_tmp
    FileUtils.mkdir_p(TMP_DIR)
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
