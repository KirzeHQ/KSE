class CreateAccounts < ActiveRecord::Migration[8.1]
  def change
    create_table :accounts do |t|
      t.string :email, null: false
      t.string :name
      t.string :google_sub
      t.string :api_token

      t.timestamps
    end

    add_index :accounts, :email, unique: true
    add_index :accounts, :api_token, unique: true
    add_index :accounts, :google_sub, unique: true
  end
end
