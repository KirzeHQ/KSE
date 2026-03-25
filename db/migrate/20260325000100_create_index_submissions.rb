class CreateIndexSubmissions < ActiveRecord::Migration[8.1]
  def change
    unless table_exists?(:index_submissions)
      create_table :index_submissions do |t|
        t.references :api_key, null: true, foreign_key: true
        t.string :content_type
        t.integer :url_count, null: false, default: 0
        t.binary :data

        t.timestamps
      end
    end

    unless index_exists?(:index_submissions, :api_key_id)
      add_index :index_submissions, :api_key_id
    end
  end
end
