class ProcessIndexSubmissionJob < ApplicationJob
  queue_as :default

  def perform(index_submission_id)
    sub = IndexSubmission.find_by(id: index_submission_id)
    return unless sub

    begin
      processed = IndexSubmissionProcessor.new(sub.data).process!
      begin
        sub.update!(processed_at: Time.current, url_count: processed)
      rescue StandardError => e
        Rails.logger.warn("Failed updating IndexSubmission #{sub.id} after processing: #{e.class} #{e.message}")
      end
      Rails.logger.info("Processed IndexSubmission #{sub.id}: #{processed} records")
    rescue StandardError => e
      Rails.logger.error("Error processing IndexSubmission #{sub.id}: #{e.class} #{e.message}\n#{e.backtrace.join("\n")}")
      raise e
    end
  end
end
