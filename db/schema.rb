# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.1].define(version: 2026_03_28_000200) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "pg_catalog.plpgsql"
  enable_extension "unaccent"

  create_table "accounts", force: :cascade do |t|
    t.string "api_token"
    t.datetime "confirmation_sent_at"
    t.string "confirmation_token"
    t.datetime "confirmed_at"
    t.datetime "created_at", null: false
    t.string "email", null: false
    t.string "github_uid"
    t.string "name"
    t.string "password_digest"
    t.datetime "updated_at", null: false
    t.index ["api_token"], name: "index_accounts_on_api_token", unique: true
    t.index ["confirmation_token"], name: "index_accounts_on_confirmation_token", unique: true
    t.index ["email"], name: "index_accounts_on_email", unique: true
    t.index ["github_uid"], name: "index_accounts_on_github_uid", unique: true
  end

  create_table "api_keys", force: :cascade do |t|
    t.bigint "account_id", null: false
    t.datetime "created_at", null: false
    t.integer "kind", default: 0, null: false
    t.string "name"
    t.boolean "revoked", default: false, null: false
    t.string "token", null: false
    t.datetime "updated_at", null: false
    t.index ["account_id"], name: "index_api_keys_on_account_id"
    t.index ["token"], name: "index_api_keys_on_token", unique: true
  end

  create_table "crawler_jobs", force: :cascade do |t|
    t.datetime "claimed_at", precision: nil
    t.string "claimed_by"
    t.datetime "created_at", null: false
    t.text "last_error"
    t.json "payload"
    t.string "state", default: "pending", null: false
    t.datetime "updated_at", null: false
    t.string "url", null: false
    t.index ["claimed_at"], name: "index_crawler_jobs_on_claimed_at"
    t.index ["state"], name: "index_crawler_jobs_on_state"
  end

  create_table "index_submissions", force: :cascade do |t|
    t.bigint "api_key_id"
    t.string "content_type"
    t.datetime "created_at", null: false
    t.binary "data"
    t.datetime "processed_at"
    t.datetime "updated_at", null: false
    t.integer "url_count", default: 0, null: false
    t.index ["api_key_id"], name: "index_index_submissions_on_api_key_id"
  end

  create_table "indexer_jobs", force: :cascade do |t|
    t.datetime "claimed_at", precision: nil
    t.string "claimed_by"
    t.datetime "created_at", null: false
    t.text "last_error"
    t.json "payload"
    t.string "state", default: "pending", null: false
    t.datetime "updated_at", null: false
    t.string "url", null: false
    t.index ["claimed_at"], name: "index_indexer_jobs_on_claimed_at"
    t.index ["state"], name: "index_indexer_jobs_on_state"
  end

  create_table "search_blobs", force: :cascade do |t|
    t.string "content_type"
    t.datetime "created_at", null: false
    t.binary "data"
    t.integer "job_id"
    t.string "key", null: false
    t.string "source"
    t.text "text_index"
    t.tsvector "text_search"
    t.datetime "updated_at", null: false
    t.index ["job_id"], name: "index_search_blobs_on_job_id"
    t.index ["key"], name: "index_search_blobs_on_key", unique: true
    t.index ["source"], name: "index_search_blobs_on_source"
    t.index ["text_search"], name: "index_search_blobs_on_text_search_col", using: :gin
  end

  add_foreign_key "api_keys", "accounts"
  add_foreign_key "index_submissions", "api_keys"
end
