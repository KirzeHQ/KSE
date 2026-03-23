class Api::BaseController < ApplicationController
  after_action :set_performance_headers

  rescue_from StandardError, with: :handle_err
  rescue_from ActiveRecord::RecordNotFound, with: :handle_404
  rescue_from ActiveRecord::RecordInvalid, with: :handle_422

  private

  def handle_err(exception)
    if defined?(Sentry) && Sentry.respond_to?(:capture_exception)
      Sentry.capture_exception(
        exception,
        extra: {
          request_id: request.request_id,
          endpoint: "#{request.method} #{request.path}",
          params: request.filtered_parameters,
          action: action_name
        },
        tags: {
          controller: controller_name,
          action: action_name
        }
      )
    else
      Rails.logger.error("#{exception.class}: #{exception.message}\n#{exception.backtrace.join("\n")}")
    end

    render json: { error: "An unexpected error occurred" }, status: :internal_server_error
  end

  def handle_404
    render json: { error: "Resource not found" }, status: :not_found
  end

  def handle_422(exception)
    render json: { error: exception.record.errors.full_messages }, status: :unprocessable_entity
  end

  def set_performance_headers
    begin
      if defined?(QueryCount) && defined?(QueryCount::Counter)
        counter = QueryCount::Counter.counter
        response.set_header("X-DB-Queries", counter.to_s)
        response.set_header("X-DB-Cached", counter.cached.to_s) if counter.respond_to?(:cached)
      end
    rescue StandardError => e
      Rails.logger.debug("Performance headers not available: #{e.class} #{e.message}")
    end

    response.set_header("X-Cache-Hits", (Thread.current[:cache_hits] || 0).to_s)
    response.set_header("X-Cache-Misses", (Thread.current[:cache_misses] || 0).to_s)
  end
end
