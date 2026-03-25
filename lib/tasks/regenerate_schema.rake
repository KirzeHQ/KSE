# frozen_string_literal: true

require "fileutils"
require "open3"
require "securerandom"
require "timeout"
require "socket"
require "pg"

namespace :db do
  desc "Regenerate db/schema.rb. Defaults: SQLite; set USE_CURRENT_DB=1 to use current DB; set USE_TEMP_PG=1 to spin up a temporary Postgres Docker container and use that."
  task regenerate_schema: :environment do
    rails_root = Rails.root
    migrations_dir = rails_root.join("db", "migrate")
    tmp_migrate = rails_root.join("tmp", "schema_migrate")
    tmp_db = rails_root.join("tmp", "schema_temp.sqlite3")
    use_current_db = ENV["USE_CURRENT_DB"].to_s == "1"
    use_temp_pg = ENV["USE_TEMP_PG"].to_s == "1"
    skipped = []

    if use_current_db
      puts "Using current DB connection to run migrations and dump schema (USE_CURRENT_DB=1)."
      Rake::Task["db:migrate"].invoke
      Rake::Task["db:schema:dump"].invoke
      puts "Wrote #{rails_root.join('db', 'schema.rb')} from current DB."
      next
    end

    if use_temp_pg
      puts "Spawning temporary Postgres container via Docker to run migrations (USE_TEMP_PG=1)."
      _, _, docker_check_status = Open3.capture3("docker", "--version")
      unless docker_check_status.success?
        raise "docker CLI not available. Install Docker or run with USE_CURRENT_DB=1"
      end

      container_name = "kse-temp-pg-#{SecureRandom.hex(6)}"
      pg_user = ENV["TEMP_PG_USER"] || "postgres"
      pg_password = ENV["TEMP_PG_PASSWORD"] || "password"
      pg_db = ENV["TEMP_PG_DB"] || "temp_schema"
      pg_image = ENV["TEMP_PG_IMAGE"] || "postgres:15"

      begin
        server = TCPServer.new("127.0.0.1", 0)
        host_port = server.addr[1]
      ensure
        server.close if server
      end

      stdout, stderr, status = Open3.capture3(
        "docker", "run", "-d",
        "-e", "POSTGRES_USER=#{pg_user}",
        "-e", "POSTGRES_PASSWORD=#{pg_password}",
        "-e", "POSTGRES_DB=#{pg_db}",
        "-p", "#{host_port}:5432",
        "--name", container_name,
        pg_image
      )

      unless status.success?
        raise "Failed to start docker container: #{stderr}"
      end

      container_id = stdout.strip
      puts "Started container #{container_name} (id=#{container_id})"

      begin
        # host_port is already reserved and mapped in the docker run command
        host_port = host_port.to_s

        Timeout.timeout(60) do
          loop do
            begin
              conn = PG::Connection.open(host: "127.0.0.1", port: host_port.to_i, dbname: pg_db, user: pg_user, password: pg_password)
              conn.exec("SELECT 1")
              conn.close
              break
            rescue PG::Error, Errno::ECONNREFUSED, Errno::EHOSTUNREACH, SocketError
              sleep 0.2
            end
          end
        end

        puts "Postgres ready on host port #{host_port}"

        # Verify container still running; if it exited early we'll grab logs for debugging
        inspect_out, _, inspect_status = Open3.capture3("docker", "inspect", "-f", "{{.State.Running}}", container_name)
        unless inspect_status.success? && inspect_out.to_s.strip == "true"
          logs, _, _ = Open3.capture3("docker", "logs", container_name)
          raise "Postgres container #{container_name} exited unexpectedly. Logs:\n#{logs}"
        end

        FileUtils.rm_rf(tmp_migrate)
        FileUtils.mkdir_p(tmp_migrate)
        Dir.glob(migrations_dir.join("*.rb").to_s).sort.each do |mf|
          FileUtils.cp(mf, tmp_migrate.join(File.basename(mf)).to_s)
        end

        original_config = nil
        begin
          original_config = ActiveRecord::Base.connection_db_config.configuration_hash rescue nil

          ActiveRecord::Base.establish_connection(
            adapter: "postgresql",
            host: "127.0.0.1",
            port: host_port.to_i,
            database: pg_db,
            username: pg_user,
            password: pg_password
          )

          migrations_paths = [ tmp_migrate.to_s ]
          migration_context = ActiveRecord::MigrationContext.new(migrations_paths)

          begin
            migration_context.migrate
          rescue StandardError => e
            logs, _, _ = Open3.capture3("docker", "logs", container_name)
            raise "Migrations failed: #{e.class}: #{e.message}\nContainer logs:\n#{logs}"
          end

          db_url = "postgresql://#{pg_user}:#{pg_password}@127.0.0.1:#{host_port}/#{pg_db}"
          puts "Dumping schema via external rails process using DATABASE_URL=#{db_url}"
          env = { 'DATABASE_URL' => db_url, 'RAILS_ENV' => ENV['RAILS_ENV'] || 'development' }
          stdout, stderr, status = Open3.capture3(env, "bin/rails", "db:schema:dump")
          unless status.success?
            logs, _, _ = Open3.capture3("docker", "logs", container_name)
            raise "db:schema:dump failed: #{stderr}\nContainer logs:\n#{logs}"
          end
          puts stdout if stdout && !stdout.empty?
          puts "Wrote #{rails_root.join('db','schema.rb')}"
        ensure
          if original_config
            ActiveRecord::Base.establish_connection(original_config)
          else
            ActiveRecord::Base.clear_all_connections!
          end
        end
      rescue Timeout::Error => e
        raise "Timed out waiting for Postgres container to be ready: #{e.message}"
      ensure
        puts "Stopping and removing container #{container_name}..."
        Open3.capture3("docker", "rm", "-f", container_name)
        puts "Container #{container_name} removed."
      end

      next
    end

    # Default: SQLite approach (skip Postgres-specific migrations)
    FileUtils.rm_rf(tmp_migrate)
    FileUtils.mkdir_p(tmp_migrate)

    Dir.glob(migrations_dir.join("*.rb").to_s).sort.each do |mf|
      content = File.read(mf)
      # Detect migrations that are likely Postgres/DB-specific and skip them
      if content.match?(/CONCURRENTLY|to_tsvector|USING\s+gin|enable_extension|disable_ddl_transaction!|execute\s+<<-?SQL|add_index\s+.*using/i)
        skipped << File.basename(mf)
        next
      end
      FileUtils.cp(mf, tmp_migrate.join(File.basename(mf)).to_s)
    end

    if Dir.glob(tmp_migrate.join("*.rb").to_s).empty?
      puts "No compatible migrations found to run in temporary DB. Skipping generation."
      puts "Skipped migrations: #{skipped.join(', ')}" unless skipped.empty?
      next
    end

    FileUtils.rm_f(tmp_db)
    original_config = nil
    begin
      original_config = ActiveRecord::Base.connection_db_config.configuration_hash rescue nil

      ActiveRecord::Base.establish_connection(adapter: "sqlite3", database: tmp_db.to_s)

      migrations_paths = [ tmp_migrate.to_s ]
      migration_context = ActiveRecord::MigrationContext.new(migrations_paths)

      if migration_context.respond_to?(:migrate)
        migration_context.migrate
      else
        raise "MigrationContext not available to run migrations"
      end

      schema_file = rails_root.join("db", "schema.rb")
      File.open(schema_file, "w") do |f|
        f.puts "# This file was generated by rake db:regenerate_schema"
        if skipped.any?
          f.puts "# Note: the following migrations were skipped because they appear DB-specific: #{skipped.join(', ')}"
          f.puts "# You may need to recreate PG-specific indexes/extensions manually.\n"
        end
        ActiveRecord::SchemaDumper.dump(ActiveRecord::Base.connection_pool, f)
      end

      puts "Wrote #{schema_file}"
    rescue StandardError => e
      warn "Failed to generate schema: #{e.class}: #{e.message}"
      warn e.backtrace.join("\n") if e.backtrace
      raise
    ensure
      if original_config
        ActiveRecord::Base.establish_connection(original_config)
      else
        ActiveRecord::Base.clear_all_connections!
      end
    end
  end
end
