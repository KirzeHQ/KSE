class AddGithubUidToAccounts < ActiveRecord::Migration[8.1]
  def change
    add_column :accounts, :github_uid, :string
    add_index :accounts, :github_uid, unique: true
  end
end
