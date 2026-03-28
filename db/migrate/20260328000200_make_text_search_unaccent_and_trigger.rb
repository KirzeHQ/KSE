class MakeTextSearchUnaccentAndTrigger < ActiveRecord::Migration[8.1]
  disable_ddl_transaction!

  def up
    execute <<-SQL.squish
      CREATE EXTENSION IF NOT EXISTS unaccent;
    SQL

    # Create or replace a trigger function that applies unaccent when building the tsvector
    execute <<-SQL
      CREATE OR REPLACE FUNCTION search_blobs_update_text_search() RETURNS trigger AS $$
      begin
        new.text_search := to_tsvector('english', unaccent(coalesce(new.text_index, '')) || ' ' || unaccent(coalesce(new.key, '')));
        return new;
      end
      $$ LANGUAGE plpgsql;
    SQL

    # Replace any existing trigger to use our function
    execute <<-SQL.squish
      DROP TRIGGER IF EXISTS search_blobs_text_search_update ON search_blobs;
    SQL

    execute <<-SQL.squish
      CREATE TRIGGER search_blobs_text_search_update BEFORE INSERT OR UPDATE ON search_blobs
      FOR EACH ROW EXECUTE FUNCTION search_blobs_update_text_search();
    SQL

    # Update existing rows to use unaccented tsvector
    execute <<-SQL.squish
      UPDATE search_blobs SET text_search = to_tsvector('english', unaccent(coalesce(text_index, '')) || ' ' || unaccent(coalesce(key, '')));
    SQL
  end

  def down
    execute <<-SQL.squish
      DROP TRIGGER IF EXISTS search_blobs_text_search_update ON search_blobs;
    SQL

    execute <<-SQL.squish
      DROP FUNCTION IF EXISTS search_blobs_update_text_search();
    SQL

    # Recompute without unaccent
    execute <<-SQL.squish
      UPDATE search_blobs SET text_search = to_tsvector('english', coalesce(text_index, '') || ' ' || coalesce(key, ''));
    SQL
  end
end
