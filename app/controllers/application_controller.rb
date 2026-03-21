class ApplicationController < ActionController::API
  # Policy Pundit
  # include Pundit::Authorization
  # include Pagy::Method
  # include ActionController::MimeResponds

  rescue_from StandardError, with: :handle_error
  rescue_from ActionController::InvalidAuthenticityToken, with: :handle_invalid_auth_token
  rescue_from ActiveRecord::RecordNotFound, with: :render_not_found

  def handle_error(error)
    logger.error "Error: #{error.message}"
    logger.error error.backtrace.join("\n")
    render json: { error: "An unexpected error occurred" }, status: :internal_server_error
  end
  def handle_invalid_auth_token
    render json: { error: "Invalid authenticity token" }, status: :unprocessable_entity
  end
  def render_not_found
    render json: { error: "Resource not found" }, status: :not_found
  end
end
