class AddTextSearchTsvectorToSearchBlobs < ActiveRecord::Migration[8.1]
  disable_ddl_transaction!

  def up
    # Ensure unaccent is available
    execute <<-SQL.squish
      CREATE EXTENSION IF NOT EXISTS unaccent;
    SQL

    # Add the stored tsvector column
    execute <<-SQL.squish
      ALTER TABLE search_blobs ADD COLUMN IF NOT EXISTS text_search tsvector;
    SQL

    # Populate the column for existing rows
    execute <<-SQL.squish
      UPDATE search_blobs SET text_search = to_tsvector('english', coalesce(text_index, '') || ' ' || coalesce(key, ''));
    SQL

    # Create a GIN index on the stored column
    execute <<-SQL.squish
      CREATE INDEX CONCURRENTLY IF NOT EXISTS index_search_blobs_on_text_search_col ON search_blobs USING gin(text_search);
    SQL

    # Create/update the trigger to keep the tsvector up-to-date
    execute <<-SQL.squish
      DROP TRIGGER IF EXISTS search_blobs_text_search_update ON search_blobs;
    SQL

    execute <<-SQL.squish
      CREATE TRIGGER search_blobs_text_search_update BEFORE INSERT OR UPDATE ON search_blobs
      FOR EACH ROW EXECUTE FUNCTION tsvector_update_trigger('text_search', 'pg_catalog.english', 'text_index', 'key');
    SQL

    # Drop the old expression index if present
    execute <<-SQL.squish
      DROP INDEX CONCURRENTLY IF EXISTS index_search_blobs_on_text_search;
    SQL
  end

  def down
    execute <<-SQL.squish
      DROP TRIGGER IF EXISTS search_blobs_text_search_update ON search_blobs;
    SQL

    execute <<-SQL.squish
      DROP INDEX CONCURRENTLY IF EXISTS index_search_blobs_on_text_search_col;
    SQL

    execute <<-SQL.squish
      ALTER TABLE search_blobs DROP COLUMN IF EXISTS text_search;
    SQL

    # Recreate the original expression index if it doesn't exist
    execute <<-SQL.squish
      CREATE INDEX CONCURRENTLY IF NOT EXISTS index_search_blobs_on_text_search ON search_blobs
      USING gin(to_tsvector('english', coalesce(text_index, '') || ' ' || coalesce(key, '')));
    SQL
  end
end
