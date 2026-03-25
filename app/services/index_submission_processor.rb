require "digest"

class IndexSubmissionProcessor
  def initialize(data)
    @data = data.to_s.force_encoding(Encoding::BINARY)
    @io = StringIO.new(@data)
  end

  # Processes the binary payload and creates/updates SearchBlob rows for each record.
  # Returns number of processed records.
  def process!
    rows = []
    processed = 0
    now = Time.current
    while !@io.eof?
      rec = read_record
      break unless rec
      next unless rec[:url].present?

      key = "url:#{Digest::SHA256.hexdigest(rec[:url])}"
      text_index = [ rec[:title], rec[:description], rec[:content] ].compact.join("\n")[0..10000]
      # normalize crawl_date to milliseconds
      crawl_date_ms = rec[:crawl_date] ? (rec[:crawl_date].to_f * 1000).to_i : nil
      data_hash = rec.merge(crawl_date: crawl_date_ms)

      rows << {
        key: key,
        source: "indexer",
        job_id: nil,
        content_type: "application/octet-stream",
        data: data_hash.to_json,
        text_index: text_index,
        created_at: now,
        updated_at: now
      }

      processed += 1
    end

    # bulk upsert in slices to avoid param limits
    if rows.any?
      rows.each_slice(500) do |slice|
        begin
          if Rails.logger.respond_to?(:silence)
            Rails.logger.silence { SearchBlob.upsert_all(slice, unique_by: %i[key]) }
          else
            SearchBlob.upsert_all(slice, unique_by: %i[key])
          end
        rescue StandardError => e
          Rails.logger.error("IndexSubmissionProcessor upsert_all failed for slice: #{e.class} #{e.message}")
          # fallback to per-record save
          slice.each do |r|
            begin
              if Rails.logger.respond_to?(:silence)
                Rails.logger.silence do
                  sb = SearchBlob.find_or_initialize_by(key: r[:key])
                  sb.source = r[:source]
                  sb.job_id = r[:job_id]
                  sb.content_type = r[:content_type]
                  sb.data = r[:data]
                  sb.text_index = r[:text_index]
                  sb.save!
                end
              else
                sb = SearchBlob.find_or_initialize_by(key: r[:key])
                sb.source = r[:source]
                sb.job_id = r[:job_id]
                sb.content_type = r[:content_type]
                sb.data = r[:data]
                sb.text_index = r[:text_index]
                sb.save!
              end
            rescue StandardError => se
              Rails.logger.error("IndexSubmissionProcessor fallback save failed: #{se.class} #{se.message}")
            end
          end
        end
      end
    end

    processed
  end

  private

  def read_bytes(n)
    b = @io.read(n)
    return nil if b.nil? || b.bytesize < n
    b.force_encoding(Encoding::BINARY)
  end

  def read_uint32
    b = read_bytes(4) or return nil
    b.unpack1("N")
  end

  def read_uint16
    b = read_bytes(2) or return nil
    b.unpack1("n")
  end

  def read_uint64
    b = read_bytes(8) or return nil
    # big-endian unsigned 64-bit
    b.unpack1("Q>")
  end

  def read_raw_string(len)
    len = len.to_i
    return "" if len == 0
    b = read_bytes(len) or return nil
    b
  end

  def read_record
    body = +""

    # URL
    url_len = read_uint32 or return nil
    body << [ url_len ].pack("N")
    url_raw = read_raw_string(url_len) or return nil
    body << url_raw
    url = url_raw.force_encoding("UTF-8").scrub("")

    # title
    title_len = read_uint32 or return nil
    body << [ title_len ].pack("N")
    title_raw = read_raw_string(title_len) or return nil
    body << title_raw
    title = title_raw.force_encoding("UTF-8").scrub("")

    # content
    content_len = read_uint32 or return nil
    body << [ content_len ].pack("N")
    content_raw = read_raw_string(content_len) or return nil
    body << content_raw
    content = content_raw.force_encoding("UTF-8").scrub("")

    # description
    desc_len = read_uint32 or return nil
    body << [ desc_len ].pack("N")
    desc_raw = read_raw_string(desc_len) or return nil
    body << desc_raw
    description = desc_raw.force_encoding("UTF-8").scrub("")

    # sitename
    sitename_len = read_uint32 or return nil
    body << [ sitename_len ].pack("N")
    sitename_raw = read_raw_string(sitename_len) or return nil
    body << sitename_raw
    sitename = sitename_raw.force_encoding("UTF-8").scrub("")

    # crawl_date (8 bytes big-endian)
    date_raw = read_bytes(8) or return nil
    body << date_raw
    crawl_date_ms = date_raw.unpack1("Q>")
    crawl_date = Time.at(crawl_date_ms / 1000.0)

    # status code (2 bytes)
    sc_raw = read_bytes(2) or return nil
    body << sc_raw
    status_code = sc_raw.unpack1("n")

    # outlink count (4 bytes) + each outlink (4-byte len + bytes)
    outcount_raw = read_bytes(4) or return nil
    body << outcount_raw
    outcount = outcount_raw.unpack1("N")
    outlinks = []
    outcount.times do
      l_raw = read_bytes(4) or return nil
      body << l_raw
      l = l_raw.unpack1("N")
      o_raw = read_raw_string(l) or return nil
      body << o_raw
      outlinks << o_raw.force_encoding("UTF-8").scrub("")
    end

    # sha256 hash (32 bytes)
    hash_raw = read_bytes(32) or return nil
    computed = Digest::SHA256.digest(body)
    hash_ok = secure_compare_hashes(computed, hash_raw)

    {
      url: url,
      title: title,
      content: content,
      description: description,
      sitename: sitename,
      crawl_date: crawl_date,
      status_code: status_code,
      outlinks: outlinks,
      hash_ok: hash_ok
    }
  rescue StandardError => e
    Rails.logger.error("IndexSubmissionProcessor read_record error: #{e.class} #{e.message}")
    nil
  end

  def save_record(rec)
    return unless rec && rec[:url].present?
    key = "url:#{Digest::SHA256.hexdigest(rec[:url])}"
    sb = SearchBlob.find_or_initialize_by(key: key)
    sb.source = "indexer"
    sb.job_id = nil
    sb.content_type = "application/octet-stream"
    sb.data = rec.to_json.b
    sb.text_index = [ rec[:title], rec[:description], rec[:content] ].compact.join("\n")[0..10000]
    sb.save!
  rescue StandardError => e
    Rails.logger.error("IndexSubmissionProcessor save_record error: #{e.class} #{e.message}")
  end

  # constant-time comparison
  def secure_compare_hashes(a, b)
    return false unless a && b && a.bytesize == b.bytesize
    l = a.bytesize
    res = 0
    l.times { |i| res |= a.getbyte(i) ^ b.getbyte(i) }
    res == 0
  end
end
