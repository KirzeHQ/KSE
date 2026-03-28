Rake::Task["db:migrate"].enhance do
  puts "== Annotating models =="
  system("bundle exec annotaterb models")
end