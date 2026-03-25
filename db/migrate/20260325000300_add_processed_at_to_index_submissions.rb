class AddProcessedAtToIndexSubmissions < ActiveRecord::Migration[8.1]
  def change
    unless column_exists?(:index_submissions, :processed_at)
      add_column :index_submissions, :processed_at, :datetime
    end
  end
end
