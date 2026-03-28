class DbIndexManager
  class << self
    # Ensure the GIN full-text index exists for `search_blobs`.
    def ensure_gin_index!(index_name: "index_search_blobs_on_text_search_col", table: "search_blobs")
      conn = ActiveRecord::Base.connection
      return unless postgresql?(conn)


      if fulltext_index_exists?(conn, table)
        Rails.logger.info "Full-text index already exists for #{table}"
        return
      end

      ensure_unaccent_extension(conn)

      table_ident = conn.quote_table_name(table)
      idx_ident = conn.quote_column_name(index_name)

      # Add a stored tsvector column if missing, then populate it using unaccent.
      unless conn.column_exists?(table, :text_search)
        Rails.logger.info "Adding tsvector column text_search to #{table}"
        conn.execute("ALTER TABLE #{table_ident} ADD COLUMN IF NOT EXISTS text_search tsvector;")
        Rails.logger.info "Populating text_search column (using unaccent)"
        conn.execute("UPDATE #{table_ident} SET text_search = to_tsvector('english', unaccent(coalesce(text_index, '')) || ' ' || unaccent(coalesce(key, '')))")
      end

      # Create a GIN index on the stored column
      begin
        Rails.logger.info "Creating GIN index #{index_name} on column text_search (concurrently)"
        conn.execute("CREATE INDEX CONCURRENTLY #{idx_ident} ON #{table_ident} USING gin(text_search);")
        Rails.logger.info "Created GIN index #{index_name}"
      rescue ActiveRecord::StatementInvalid => e
        if e.message =~ /already exists|duplicate|concurrently/i
          Rails.logger.info "Index creation skipped or already exists: #{e.message}"
        else
          raise
        end
      end

      trigger_name = "search_blobs_text_search_update"
      unless trigger_exists?(conn, trigger_name, table)
        Rails.logger.info "Creating unaccent tsvector update trigger on #{table}"

        # create or replace the helper trigger function
        conn.execute(<<-SQL)
          CREATE OR REPLACE FUNCTION search_blobs_update_text_search() RETURNS trigger AS $$
          begin
            new.text_search := to_tsvector('english', unaccent(coalesce(new.text_index, '')) || ' ' || unaccent(coalesce(new.key, '')));
            return new;
          end
          $$ LANGUAGE plpgsql;
        SQL

        conn.execute("CREATE TRIGGER #{trigger_name} BEFORE INSERT OR UPDATE ON #{table_ident} FOR EACH ROW EXECUTE FUNCTION search_blobs_update_text_search();")
        Rails.logger.info "Created trigger #{trigger_name}"
      end
    rescue ActiveRecord::StatementInvalid => e
      Rails.logger.error "Failed to ensure GIN index: #{e.class}: #{e.message}"
      raise
    end

    private

    def postgresql?(conn)
      conn.adapter_name.to_s.downcase.include?("postgres")
    rescue
      false
    end

    def index_exists?(conn, index_name, table)
      sql = "SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = #{conn.quote(table)} AND indexname = #{conn.quote(index_name)} LIMIT 1"
      result = conn.exec_query(sql)
      result.any?
    end

    def fulltext_index_exists?(conn, table)
      sql = "SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = #{conn.quote(table)} AND (indexdef ILIKE '%to_tsvector(%' OR indexdef ILIKE '%text_search%') LIMIT 1"
      conn.exec_query(sql).any?
    end

    def trigger_exists?(conn, trigger_name, table)
      sql = "SELECT 1 FROM pg_trigger WHERE tgname = #{conn.quote(trigger_name)} AND tgrelid = #{conn.quote(table)}::regclass LIMIT 1"
      conn.exec_query(sql).any?
    end

    def ensure_unaccent_extension(conn)
      result = conn.exec_query("SELECT extname FROM pg_extension WHERE extname = 'unaccent'")
      if result.rows.empty?
        Rails.logger.info "Enabling unaccent extension"
        conn.execute("CREATE EXTENSION IF NOT EXISTS unaccent;")
      end
    rescue ActiveRecord::StatementInvalid => e
      Rails.logger.warn "Could not enable unaccent extension: #{e.message}"
    end
  end
end
