namespace :db do
  desc "Ensure GIN full-text index exists for search_blobs"
  task ensure_gin_index: :environment do
    require Rails.root.join("lib", "db_index_manager").to_s unless defined?(DbIndexManager)
    DbIndexManager.ensure_gin_index!
  end
end
