# Auto-create the GIN full-text index
require Rails.root.join("lib", "db_index_manager").to_s unless defined?(DbIndexManager)

Thread.new do
  begin
    # small delay to allow DB connections to become ready
    sleep 5
    DbIndexManager.ensure_gin_index!
  rescue => e
    Rails.logger.error "Auto-create GIN index failed: #{e.class}: #{e.message}"
  end
end
