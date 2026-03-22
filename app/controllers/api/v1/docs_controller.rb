class Api::V1::DocsController < Api::Base
  def index
    spec = YAML.safe_load(File.read(Rails.root.join("docs", "api.yaml")))
    escaped_spec_json = ERB::Util.json_escape(spec.to_json)

    render html: <<~HTML.html_safe
      <!DOCTYPE html>
      <html>
        <head>
          <title>API Reference</title>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
        </head>
        <body>
          <div id="app"></div>
          <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
          <script>
            Scalar.createApiReference('#app', {
              spec: { content: #{escaped_spec_json} },
              theme: 'purple',
              hideClientButton: true,
              hideDarkModeToggle: true,
              showDeveloperTools: 'never',
              agent: { disabled: true }
            })
          </script>
        </body>
      </html>
    HTML
  end
end
