class AddPasswordDigestAndRemoveGoogleSubFromAccounts < ActiveRecord::Migration[8.1]
  def change
    add_column :accounts, :password_digest, :string

    if index_exists?(:accounts, :google_sub)
      remove_index :accounts, :google_sub
    end

    if column_exists?(:accounts, :google_sub)
      remove_column :accounts, :google_sub
    end
  end
end
