# Load the Rails application.
require_relative "application"

# Initialize the Rails application.
Rails.application.initialize!

Rails.application.config.hosts = [
  IPAddr.new("0.0.0.0/0"),
  IPAddr.new("::/0"),
  "kse.kirze.de"
]