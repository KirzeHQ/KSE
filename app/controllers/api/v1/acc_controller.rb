class Api::V1::AccController < Api::BaseController
  # POST /api/v1/acc/login
  def login
    email = params[:email].to_s.downcase
    password = params[:password].to_s

    return render json: { error: "Missing credentials" }, status: :bad_request if email.blank? || password.blank?

    account = Account.find_by(email: email)
    unless account&.authenticate(password)
      return render json: { error: "Invalid email or password" }, status: :unauthorized
    end

    unless account.confirmed?
      return render json: { error: "Email not confirmed" }, status: :forbidden
    end

    account.ensure_api_token!
    render json: { secret: account.api_token, account: { id: account.id, email: account.email, name: account.name } }
  end

  # POST /api/v1/acc/register
  def register
    email = params[:email].to_s.downcase
    password = params[:password].to_s
    name = params[:name].to_s

    if email.blank? || password.blank?
      return render json: { error: "Missing email or password" }, status: :bad_request
    end

    account = Account.create!(email: email, password: password, name: (name.presence || email.split("@").first))
    account.regenerate_api_token!

    if defined?(AccountsMailer)
      token = account.generate_confirmation_token!
      frontend = ENV.fetch("FRONTEND_URL", nil)
      confirm_url = frontend ? "#{frontend}/confirm?token=#{token}" : nil
      AccountsMailer.with(account: account, token: token, confirm_url: confirm_url).confirmation.deliver_later
    end

    render json: { secret: account.api_token, account: { id: account.id, email: account.email, name: account.name } }, status: :created
  end

  # POST /api/v1/acc/resend_confirmation
  def resend_confirmation
    email = params[:email].to_s.downcase
    account = Account.find_by(email: email)
    return render json: { error: "Account not found" }, status: :not_found unless account

    token = account.generate_confirmation_token!
    frontend = ENV.fetch("FRONTEND_URL", nil)
    confirm_url = frontend ? "#{frontend}/confirm?token=#{token}" : nil
    AccountsMailer.with(account: account, token: token, confirm_url: confirm_url).confirmation.deliver_later
    render json: { ok: true }
  end

  # POST /api/v1/acc/confirm
  def confirm
    token = params[:token].to_s
    return render json: { error: "Missing token" }, status: :bad_request if token.blank?

    account = Account.find_by(confirmation_token: token)
    return render json: { error: "Invalid token" }, status: :not_found unless account

    account.confirm!
    render json: { ok: true }
  end

  # DELETE /api/v1/acc/delete
  def delete
    require_auth!
    confirm_email = params[:confirm_email].to_s
    unless confirm_email.present? && confirm_email == @current_account.email
      return render json: { error: "Confirmation does not match account email" }, status: :forbidden
    end

    @current_account.destroy!
    head :no_content
  end

  # PATCH /api/v1/acc/edit
  def edit
    require_auth!
    permitted = params.permit(:name, :email, :password)
    if permitted[:email].present? && Account.where.not(id: @current_account.id).exists?(email: permitted[:email])
      return render json: { error: "Email already taken" }, status: :unprocessable_entity
    end

    if permitted[:password].present?
      @current_account.password = permitted[:password]
    end

    @current_account.update!(permitted.except(:password))
    @current_account.save! if permitted[:password].present?

    render json: { account: { id: @current_account.id, email: @current_account.email, name: @current_account.name } }
  end

  private

  def require_auth!
    auth = request.headers["Authorization"].to_s
    if auth.present? && auth.start_with?("Bearer ")
      token = auth.split(" ", 2).last
      @current_account = Account.find_by(api_token: token)
    end
    return if @current_account

    render json: { error: "Unauthorized" }, status: :unauthorized
  end
end
