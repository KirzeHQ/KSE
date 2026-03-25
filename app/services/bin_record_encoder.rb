require "digest"

class BinRecordEncoder
  def self.encode_string_with_len(str)
    s = (str || "").to_s.encode(Encoding::UTF_8)
    len = [ s.bytesize ].pack("N")
    len + s
  end

  def self.encode_record(rec)
    parts = []
    parts << encode_string_with_len(rec[:url] || "")
    parts << encode_string_with_len(rec[:title] || "")
    parts << encode_string_with_len(rec[:content] || "")
    parts << encode_string_with_len(rec[:description] || "")
    parts << encode_string_with_len(rec[:sitename] || "")

    date_ms = (rec[:crawl_date] ? (rec[:crawl_date].to_f * 1000).to_i : (Time.now.to_f * 1000).to_i)
    parts << [ date_ms ].pack("Q>")

    parts << [ (rec[:status_code] || 0) ].pack("n")

    out = Array(rec[:outlinks])
    parts << [ out.length ].pack("N")
    out.each do |o|
      parts << encode_string_with_len(o)
    end

    body = parts.join
    hash = Digest::SHA256.digest(body)
    body + hash
  end

  def self.encode_batch(recs)
    recs.map { |r| encode_record(r) }.join
  end
end
