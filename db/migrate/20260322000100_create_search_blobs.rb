class CreateSearchBlobs < ActiveRecord::Migration[8.1]
  def change
    create_table :search_blobs do |t|
      t.string :key, null: false
      t.string :source
      t.integer :job_id
      t.string :content_type
      t.binary :data
      t.text :text_index

      t.timestamps
    end

    add_index :search_blobs, :key, unique: true
    add_index :search_blobs, :source
    add_index :search_blobs, :job_id
  end
end
