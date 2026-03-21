class Api::V1::CrawlerController < Api::BaseController
  require "fileutils"

  TMP_DIR = Rails.root.join("tmp", "api", "crawler")

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
    ensure_tmp
    payload = parse_json_or_params
    File.write(TMP_DIR.join("#{params[:id]}-discovered.json"), JSON.pretty_generate(payload))
    render json: { ok: true }
  end

  # POST /api/v1/crawler/:id/error
  def error
    ensure_tmp
    payload = parse_json_or_params
    File.write(TMP_DIR.join("#{params[:id]}-error.json"), JSON.pretty_generate(payload))
    render json: { ok: true }, status: :accepted
  end

  private

  def extract_worker
    auth = request.headers["Authorization"]
    if auth.present? && auth.start_with?("Bearer ")
      return auth.split(" ", 2).last
    end
    request.remote_ip
  end

  def ensure_tmp
    FileUtils.mkdir_p(TMP_DIR)
  end

  def parse_json_or_params
    raw = request.raw_post.to_s
    return JSON.parse(raw) if raw.present?
    params.to_unsafe_h.except(:controller, :action, :id)
  rescue JSON::ParserError
    { raw: raw }
  end
end
