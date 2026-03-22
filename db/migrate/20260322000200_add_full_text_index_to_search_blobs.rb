class AddFullTextIndexToSearchBlobs < ActiveRecord::Migration[8.1]
  disable_ddl_transaction!

  def up
    # create a GIN index on the tsvector expression built from text_index and key
    execute <<-SQL.squish
      CREATE INDEX CONCURRENTLY index_search_blobs_on_text_search ON search_blobs
      USING gin(to_tsvector('english', coalesce(text_index, '') || ' ' || coalesce(key, '')));
    SQL
  end

  def down
    execute <<-SQL.squish
      DROP INDEX CONCURRENTLY IF EXISTS index_search_blobs_on_text_search;
    SQL
  end
end
