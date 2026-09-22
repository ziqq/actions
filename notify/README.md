# Template notification

`notify` turns a caller-owned CommonMark template into Discord Markdown and
Telegram-safe HTML. It supports strict validation, local preview files,
multiple targets, provider-native payloads, attachments, timeouts, retries,
and aggregate error handling.

## Send a notification

The caller checks out its repository because all templates, payloads, and local
attachments are resolved below `github.workspace`.

```yaml
- uses: actions/checkout@FULL_COMMIT_SHA

- uses: ziqq/actions/notify@FULL_COMMIT_SHA
  with:
    providers: discord,telegram
    template-path: .github/notify/release.md.tmpl
    variables: |
      {
        "package": "flutter_in_store_app_version_checker",
        "version": "3.1.0",
        "status": "success",
        "changelog_url": "https://github.com/ziqq/flutter_in_store_app_version_checker/releases/tag/v3.1.0"
      }
    discord-webhooks: ${{ secrets.DISCORD_WEBHOOKS }}
    telegram-bot-token: ${{ secrets.TELEGRAM_BOT_TOKEN }}
    telegram-targets: >-
      {"targets":[{"chatId":"${{ secrets.TELEGRAM_CHAT_ID }}"}]}
```

Use immutable full SHAs for this action and every action in the caller.

## Template contract

Use the `.md.tmpl` extension so editors, reviews, and local tooling recognize
the canonical format:

```markdown
# 🚀 {{package}} {{version}}

Status: **{{status}}**
Triggered by: {{github.actor}}

{{#if changelog_url}}
[Open changelog]({{url changelog_url}})
{{/if}}
```

| Expression | Meaning |
|---|---|
| `{{name}}` | Escaped text value. Dotted access is supported. |
| `{{url name}}` | Validated HTTP(S) URL for a Markdown link destination. |
| `{{#if name}}...{{/if}}` | Render the block when the scalar value is truthy. |

Every referenced variable is validated, including variables inside a false
conditional. Unknown variables and malformed blocks fail with template and
line information. Variables may contain only nested objects and scalar JSON
values; arrays and executable expressions are rejected.

The portable CommonMark subset contains paragraphs, headings, emphasis,
strong text, strikethrough, inline/fenced code, blockquotes, ordered and
unordered lists, and HTTP(S) links. Raw HTML, images, tables, and arbitrary
extensions fail validation instead of rendering differently across providers.
The parser is bundled; no regular-expression Markdown conversion is used.

Built-in values are deliberately limited to:

- `github.repository`, `github.actor`, `github.event_name`;
- `github.run_number`, `github.run_id`, `github.run_url`;
- `github.ref`, `github.ref_name`, `github.sha`, `github.server_url`;
- `github.workflow`, `github.job`, and optional `qr_url`.

The action never exposes all environment variables to a template.

## Shared and provider templates

`template-path` is the shared source. `discord-template-path` and
`telegram-template-path` override it for one provider while preserving the
same syntax and safety contract. A provider must have either a selected
template or a native payload.

## Validate and render locally in CI

`mode: validate` parses all inputs without network access and without requiring
delivery targets. `mode: render` additionally writes `discord.md` and/or
`telegram.html` with mode `0600`. It does not print message bodies.

```yaml
- uses: ziqq/actions/notify@FULL_COMMIT_SHA
  with:
    mode: render
    providers: discord,telegram
    template-path: .github/notify/release.md.tmpl
    render-output-directory: .tmp/notify-preview
```

Only `rendered-files`, lengths, and SHA-256 hashes are returned. Uploading the
rendered files is an explicit caller decision because they may contain private
release information.

## Delivery targets and policy

- `discord-webhooks` is a JSON object with a required `targets` array. Every
  target contains a webhook `url`, for example
  `{"targets":[{"url":"https://discord.com/api/webhooks/..."}]}`.
- `telegram-targets` is a JSON object with a required `targets` array. Every
  target contains `chatId` and may contain `threadId`, for example
  `{"targets":[{"chatId":"123456789"}]}`.
- `failure-policy: required` tries every target and then fails if any target
  failed. `best-effort` emits warnings and succeeds.
- `timeout-ms` defaults to 10 seconds per request.
- `max-attempts` defaults to five. Network failures, HTTP 408/409/425/429, and
  5xx responses are retried with bounded exponential backoff; `Retry-After` is
  honored.
- Telegram supports silent delivery and disabled link previews. Discord
  supports username, avatar, and TTS overrides.

`delivery-results` contains provider, one-based target index, status, and
attempt count. It never contains a webhook, bot token, chat ID, or message.

## Attachments and QR

`attachments` is a JSON array with at most ten entries and a 25 MiB limit for
each local file:

```json
[
  {
    "path": "build/app-release.apk",
    "name": "app-release.apk",
    "kind": "document",
    "providers": ["discord", "telegram"],
    "caption": "Android release"
  },
  {
    "url": "https://example.test/public-image.png",
    "kind": "photo",
    "providers": ["telegram"]
  }
]
```

Local files must remain inside the workspace. Public URLs are accepted only by
Telegram; the action does not download remote files for Discord. Every
attachment is part of the target's delivery result rather than a hidden
best-effort side effect.

`send-qr: true` adds a Telegram photo generated by `api.qrserver.com`.
`qr-data-is-public: true` is mandatory because the encoded value leaves the
runner. Never put credentials or private tokens in `qr-data`.

## Native payload escape hatch

`discord-payload-path` accepts a webhook JSON object. The action reserves
`allowed_mentions`, attachment fields, webhook URL, and thread selection.
Template content and native `content` are mutually exclusive.

`telegram-payload-path` has this shape:

```json
{
  "method": "sendMessage",
  "body": {
    "protect_content": true
  }
}
```

Allowed methods are `sendMessage`, `sendPhoto`, and `sendDocument`.
Credentials, `chat_id`, `message_thread_id`, and `parse_mode` remain action
owned. Native payloads are an advanced escape hatch; the CommonMark template
is the stable portable interface.

## Security boundaries

- Templates and payloads are UTF-8 regular files of at most 64 KiB.
- All caller paths are constrained to the workspace.
- Discord mentions are disabled with an action-owned `allowed_mentions`.
- Dynamic text cannot become Markdown; dynamic URLs require `{{url ...}}`.
- Discord and Telegram message length limits are checked before delivery.
- Secrets are masked and never included in outputs or rendered metadata.
- `render` intentionally creates message files; callers control their later
  retention and artifact visibility.
