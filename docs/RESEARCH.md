# Design research and hardening decisions

This document records the public actions reviewed before implementing
`notify` and `labeler`. A gap below is a mismatch with this repository's
requirements, not a general defect in the referenced project.

The review was refreshed on 2026-09-22. Links point to the upstream project
documentation so later maintenance can re-check assumptions instead of
depending on this snapshot.

## Notification actions

| Project | Useful ideas | Gap for this project | Decision implemented here |
|---|---|---|---|
| [appleboy/telegram-action](https://github.com/appleboy/telegram-action) | Message files, multiple chats, topics, attachments, silent delivery, and link-preview controls. | Telegram-only; templates interpolate environment-derived values; legacy Telegram Markdown can reject an entire message when dynamic text contains unbalanced markup. | Keep caller-owned template files, topics, attachments, and delivery controls; expose only allowlisted context; parse CommonMark once and emit escaped Telegram HTML. |
| [Ilshidur/action-discord](https://github.com/Ilshidur/action-discord) | Small interface, custom username/avatar, embeds, and explicit Discord mention control. | Discord-only; template interpolation can read environment/event payload data; Docker action requires a Linux runner with Docker. | Use a Node 24 action, disable mentions by default, limit template context, and retain a guarded native payload escape hatch. |
| [containrrr/shoutrrr-action](https://github.com/containrrr/shoutrrr-action) | One action can fan out to multiple notification services and targets. | A generic service URL and title/message interface does not provide the strict portable Markdown contract or provider-specific validation required here. | Use one action for Discord and Telegram, but keep explicit typed provider inputs, per-target results, and provider-aware rendering. |
| [slackapi/slack-github-action](https://github.com/slackapi/slack-github-action) | Payload files, templated payloads, configurable retries, and fail-or-report behavior. | Provider payload dialects remain caller-owned and portability is not the goal. | Add native payload escape hatches for advanced cases, while making the validated CommonMark template the stable cross-provider interface. |

## Label actions

| Project | Useful ideas | Gap for this project | Decision implemented here |
|---|---|---|---|
| [actions/labeler](https://github.com/actions/labeler) | Mature PR file/head/base-branch matching, sync behavior, and large-PR file limits. | Focuses on pull request classification; it does not own a repository label catalog or issue/discussion/release lifecycle. | Reuse bounded file matching, then integrate it with catalog sync and semantic lifecycle operations. |
| [EndBug/label-sync](https://github.com/EndBug/label-sync) | Declarative label sync, aliases for rename-in-place, dry-run, and optional deletion. | Catalog sync and lifecycle automation are separate concerns, while broad deletion is controlled by one switch. | Preserve assignments with `previousNames`; default to keeping unrelated labels; require managed-name scope plus an action input before deletion. |
| [micnncim/action-label-syncer](https://github.com/micnncim/action-label-syncer) | Compact declarative manifest and multi-repository synchronization. | Its documented default pruning deletes labels absent from the manifest, which also removes those assignments from issues and pull requests. | Never prune by default; preflight a complete mutation plan and require two explicit deletion opt-ins. |
| [dessant/label-actions](https://github.com/dessant/label-actions) | Label-added/removed hooks for issues, pull requests, and discussions. | Event reactions are keyed directly by visible label names and do not cover catalog sync, branches, comments, or releases as one lifecycle. | Resolve event rules through stable semantic IDs, support every required target type, and reject direct self-trigger loops. |

## Hardening matrix

| Risk or maintenance problem | Implemented control |
|---|---|
| A label display name changes | Stable semantic ID plus rename-in-place through `previousNames`. |
| A configuration PR supplies code to a write-capable workflow | API-loaded configuration from the pull request base SHA or default branch. |
| A sync unexpectedly deletes repository labels | `orphanPolicy: keep` by default; scoped managed patterns and a second runtime opt-in for deletion. |
| A release rule accidentally selects every issue | A non-empty semantic selector is mandatory and pull requests are excluded. |
| One label event recursively triggers itself | Configuration validation rejects a transition that mutates its own trigger label. |
| An ordinary comment restarts unrelated work | Comment transitions can require existing semantic labels and restrict allowed actors. |
| A large batch produces avoidable partial state | Full validation and preflight precede writes; target/file limits and partial-failure outputs are explicit. |
| Template data injects Markdown or mentions | Dynamic text is escaped, dynamic links require `{{url ...}}`, raw HTML/images are rejected, and Discord mentions are disabled. |
| Provider formatting diverges | A strict CommonMark subset is parsed once and rendered separately to Discord Markdown and Telegram HTML. |
| One failed destination hides successful or later deliveries | Every configured target is attempted; results are aggregated under `required` or `best-effort` policy. |
| A network or rate-limit failure becomes a flaky release | Per-request timeout, bounded exponential backoff, retryable status allowlist, and `Retry-After` support. |
| Secrets or rendered messages leak through outputs | Credentials, targets, and message bodies are omitted; only status, length, hashes, attempts, and optional private preview paths are returned. |

## Intentional boundaries

- `notify` is not a general template engine. It deliberately excludes arbitrary
  expressions, arrays, raw HTML, remote Discord downloads, and the complete
  runner environment.
- `labeler` is not transactional because GitHub has no cross-issue label
  transaction. It prevents known invalid plans before mutation and reports a
  later partial failure precisely.
- The action does not guess repository policy. Visible names, transitions,
  selectors, branches, paths, actors, and destructive scope remain in the
  caller-owned configuration.
