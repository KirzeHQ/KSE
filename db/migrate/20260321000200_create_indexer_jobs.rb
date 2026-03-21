class CreateIndexerJobs < ActiveRecord::Migration[6.0]
  def change
    create_table :indexer_jobs do |t|
      t.string :url, null: false
      t.string :state, null: false, default: "pending"
      t.json :payload
      t.datetime :claimed_at
      t.string :claimed_by
      t.text :last_error

      t.timestamps
    end

    add_index :indexer_jobs, :state
    add_index :indexer_jobs, :claimed_at
  end
end
