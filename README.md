# ziqq/actions

Reusable GitHub Actions maintained by [Anton Ustinoff](https://github.com/ziqq).

## Actions

- [`notify`](notify/README.md) validates a repository-owned CommonMark template
  and delivers it to one or more Discord and Telegram targets.
- [`labeler`](labeler/README.md) synchronizes repository labels and applies
  guarded semantic lifecycle transitions to issues, pull requests, and
  discussions without hard-coding visible label names.

The [design research](docs/RESEARCH.md) records the comparable actions that
were reviewed, their useful ideas, the gaps for this project, and the
hardening decisions implemented here.

Consumers should pin an immutable full commit SHA. Version tags are provided
for discovery, but a full SHA gives the strongest supply-chain boundary.

## Runtime and development

Both actions use the GitHub-hosted Node 24 runtime. Dependencies are bundled
into each committed `dist/index.js`; consumers do not run `npm install`.

```sh
npm ci
npm test
npm run verify
```

`npm test` rebuilds both distributions before running contract tests. A pull
request must include source, lockfile, tests, documentation, and regenerated
distribution changes in the same commit.

## Design guarantees

- Repository configuration and templates remain caller-owned.
- Templates never receive the runner's complete environment.
- Credentials, target identifiers, and rendered message bodies are excluded
  from action outputs.
- Notification failures are aggregated after every configured target is tried.
- Label transitions are planned and preflighted before the first mutation.
- Label synchronization keeps unrelated labels unless destructive pruning is
  enabled by both configuration and action input.
- Write-capable pull request workflows load configuration from a trusted base
  SHA through the GitHub API by default.

## License

[MIT](LICENSE)
