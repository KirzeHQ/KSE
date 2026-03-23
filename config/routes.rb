Rails.application.routes.draw do
  # Define your application routes per the DSL in https://guides.rubyonrails.org/routing.html

  # Reveal health status on /up that returns 200 if the app boots with no exceptions, otherwise 500.
  # Can be used by load balancers and uptime monitors to verify that the app is live.
  get "up" => "rails/health#show", as: :rails_health_check
  namespace :api do
    namespace :v1 do
      namespace :crawler do
        post "next", action: "next"
        patch ":id", action: "update"
        post ":id/error", action: "error"
      end

      namespace :indexer do
        post "next", action: "next"
        post ":id/result", action: "result"
        post ":id/error", action: "error"
      end

      namespace :acc do
        post "login", action: "login"
        post "register", action: "register"
        post "resend_confirmation", action: "resend_confirmation"
        post "confirm", action: "confirm"
        delete "delete", action: "delete"
        patch "edit", action: "edit"
      end

      namespace :oauth do
        get "github", action: "github"
        get "github/callback", action: "github_callback"
      end

      namespace :search do
        get "", action: "index"
      end
    end
  end
end
