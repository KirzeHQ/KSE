class CreateApiKeys < ActiveRecord::Migration[8.1]
  def change
    create_table :api_keys do |t|
      t.references :account, null: false, foreign_key: true
      t.integer :kind, null: false, default: 0
      t.string :token, null: false
      t.string :name
      t.boolean :revoked, null: false, default: false

      t.timestamps
    end

    add_index :api_keys, :token, unique: true
  end
end
