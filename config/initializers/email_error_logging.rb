Rails.application.config.to_prepare do
  module KseEmailDeliveryLogging
    def deliver_now(*args, &block)
      super
    rescue => e
      msg = (respond_to?(:message) ? message : (respond_to?(:mail) ? mail : nil)) rescue nil
      to = msg&.to
      subject = msg&.subject
      Rails.logger.error("[EmailDelivery] deliver_now failed: #{e.class} #{e.message} to=#{to.inspect} subject=#{subject.inspect}")
      Sentry.capture_exception(e, extra: { to: to, subject: subject, mailer: self.class.name }) if defined?(Sentry)
      raise
    end

    def deliver_later(*args, &block)
      super
    rescue => e
      Rails.logger.error("[EmailDelivery] deliver_later enqueue failed: #{e.class} #{e.message} mailer=#{self.class}")
      Sentry.capture_exception(e, extra: { mailer: self.class.name }) if defined?(Sentry)
      raise
    end
  end

  if defined?(ActionMailer::MessageDelivery) && !ActionMailer::MessageDelivery.ancestors.include?(KseEmailDeliveryLogging)
    ActionMailer::MessageDelivery.prepend(KseEmailDeliveryLogging)
  end

  module KseMailDeliveryJobLogging
    def perform(*args, **kwargs)
      super(*args, **kwargs)
    rescue => e
      mailer_name = args[0] rescue nil
      mailer_method = args[1] rescue nil
      mailer_payload = kwargs[:args] if kwargs.key?(:args)
      if mailer_payload.nil? && args.length >= 4 && args[3].is_a?(Hash)
        mailer_payload = args[3]
      end
      mailer_payload ||= (args[2..-1] rescue nil)
      Rails.logger.error("[EmailDelivery] MailDeliveryJob failed: #{e.class} #{e.message} mailer=#{mailer_name} method=#{mailer_method} args=#{mailer_payload.inspect}")
      Sentry.capture_exception(e, extra: { mailer: mailer_name, method: mailer_method, args: mailer_payload }) if defined?(Sentry)
      raise
    end
  end

  if defined?(ActionMailer::MailDeliveryJob) && !ActionMailer::MailDeliveryJob.ancestors.include?(KseMailDeliveryJobLogging)
    ActionMailer::MailDeliveryJob.prepend(KseMailDeliveryJobLogging)
  end
end
