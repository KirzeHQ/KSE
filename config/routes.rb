Rails.application.routes.draw do
  # Define your application routes per the DSL in https://guides.rubyonrails.org/routing.html

  # Reveal health status on /up that returns 200 if the app boots with no exceptions, otherwise 500.
  # Can be used by load balancers and uptime monitors to verify that the app is live.
  get "up" => "rails/health#show", as: :rails_health_check

  get "sitemap.xml" => "sitemap#index", format: "xml", as: :sitemap

  # Defines the root path route ("/")
  root "search#index"

  namespace :api do
    namespace :v1 do
      scope :crawler, controller: "api/v1/crawler" do
        post "next", action: "next"
        patch ":id", action: "update"
        post ":id/error", action: "error"
      end

      scope :indexer, controller: "api/v1/indexer" do
        post "next", action: "next"
        post ":id/result", action: "result"
        post ":id/error", action: "error"
      end
    end
  end
end
