class EnableUnaccentExtension < ActiveRecord::Migration[8.1]
  def up
    enable_extension 'unaccent' unless extension_enabled?('unaccent')
  end

  def down
    disable_extension 'unaccent' if extension_enabled?('unaccent')
  end
end
