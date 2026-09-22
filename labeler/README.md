# Semantic repository labeler

`labeler` separates stable automation semantics from repository-visible label
names. A repository may call a lifecycle state `done`, `released`, or use any
other valid GitHub label name without changing action code or workflow logic.

Every operation loads and validates the complete configuration, preflights
labels and targets, emits a mutation plan, enforces bulk limits, and only then
starts writing.

## Minimal workflow call

```yaml
- uses: ziqq/actions/labeler@FULL_COMMIT_SHA
  with:
    operation: sync-labels
    github-token: ${{ github.token }}
    config-path: .github/labels.json
```

By default the file is loaded through the GitHub API from the pull request base
SHA or repository default branch. A checkout is not required. Use
`config-source: workspace` only for trusted workflows that intentionally need a
checked-out configuration.

## Configuration schema

Configuration uses `schema: 4`:

```json
{
  "schema": 4,
  "labels": {
    "in_progress": {
      "name": "working in progress",
      "color": "ffffff",
      "description": "Work is active.",
      "previousNames": ["in progress"],
      "paths": ["lib/**"]
    },
    "waiting_for_release": {
      "name": "waiting for publish",
      "color": "0e8a16",
      "description": "Ready for publication."
    },
    "completed": {
      "name": "done",
      "color": "0e8a16",
      "description": "Published."
    }
  },
  "references": {
    "branchIssuePattern": "github-(\\d+)",
    "closingIssuePattern": "(?:close[sd]?|fixe[sd]?|resolve[sd]?)\\s+#(\\d+)"
  },
  "transitions": {
    "start_progress": {
      "add": ["in_progress"],
      "remove": ["waiting_for_release", "completed"]
    },
    "release_published": {
      "add": ["completed"],
      "remove": [],
      "removeIdPatterns": ["*_progress", "waiting_*"]
    }
  },
  "events": {
    "branchCreated": {
      "transition": "start_progress",
      "linkBranch": true
    },
    "pullRequestMerged": {
      "transition": "release_published",
      "baseBranches": ["main"]
    },
    "releasePublished": {
      "transition": "release_published",
      "selector": {
        "all": ["waiting_for_release"],
        "any": [],
        "not": ["completed"],
        "state": "all"
      }
    }
  },
  "sync": {
    "managedNamePatterns": [],
    "excludeNamePatterns": [],
    "orphanPolicy": "keep"
  }
}
```

Keys such as `in_progress` are semantic IDs. Transitions, selectors, event
rules, and glob removal refer only to those IDs. Visible names may contain any
valid GitHub label value.

### Labels and rename-in-place

- Names are compared case-insensitively.
- `previousNames` identifies the one existing label that should be renamed.
  GitHub's update endpoint preserves assignments to issues and pull requests.
- Duplicate current names, duplicate previous names, and a previous name that
  is also current fail validation before mutation.
- `paths` contains minimatch globs evaluated against pull request files.

### Transitions and semantic patterns

`add` and `remove` contain explicit semantic IDs. `removeIdPatterns` matches
semantic IDs, never visible names. This keeps glob cleanup independent from a
repository's naming language.

Pattern removal requires the action input `allow-pattern-removal: true`. A
pattern matching no semantic IDs fails preflight. An added label always wins
over a matching removal pattern.

### Release selector

`all`, `any`, and `not` are evaluated together:

- every `all` label must exist;
- at least one `any` label must exist when `any` is non-empty;
- no `not` label may exist.

The selector must contain at least one semantic label. It never implicitly
selects every repository issue. Pull requests are excluded from release issue
selection.

## Operations

| Operation | Responsibility |
|---|---|
| `sync-labels` | Create, update, and rename configured labels. Optional orphan handling is separately guarded. |
| `path-labels` | Add matching path labels and remove only configured path labels that stopped matching. |
| `branch-created` | Resolve an issue from the branch name, transition it, and optionally link the branch. |
| `pull-request` | Resolve linked issues from branch/title/body and apply opened or merged transitions. |
| `release-published` | Select issues with `all`/`any`/`not` and apply the release transition. |
| `comment-event` | Handle allowed issue-author, assignee, or discussion-author comments. |
| `label-event` | React to labeled/unlabeled events for issues, pull requests, and discussions. |
| `apply` | Apply an explicit transition to explicit target numbers and target kind. |

`apply` supports `target-kind: issue`, `pull-request`, or `discussion`.
Issue and pull request transitions use one `setLabels` request per target so
unrelated labels from the preflight snapshot are preserved. Discussion labels
use GitHub GraphQL mutations.

## Label and discussion hooks

```json
{
  "events": {
    "issueCommented": {
      "transition": "start_progress",
      "allowedActors": ["issue-author", "assignee"]
    },
    "discussionCommented": {
      "transition": "start_progress",
      "allowedActors": ["discussion-author"]
    },
    "labelChanged": [
      {
        "action": "labeled",
        "label": "needs_attention",
        "targets": ["issue", "pull-request", "discussion"],
        "transition": "start_progress"
      }
    ]
  }
}
```

A label-change transition may not add or remove its own trigger label. This is
rejected as a potential event loop even though ordinary `GITHUB_TOKEN`
mutations usually do not retrigger workflows.

## Dry-run, bulk guards, and outputs

`dry-run: true` performs API reads and emits the same complete plan without
mutations. `max-targets` defaults to 100 and applies before target mutation.
`max-files` defaults to 3,000 for path labeling. `allow-empty` is false by
default; event workflows may explicitly opt into no-op selections.

Outputs:

- `plan`: operation, trusted config source, targets, label sync actions,
  warnings, and dry-run state;
- `transition` and `targets`;
- completed `added`, `removed`, and `skipped` changes;
- `warnings` and `partial-failures`.

GitHub does not provide a transaction across several issues. Full preflight
prevents known invalid input from producing partial state. If a later API
request fails after an earlier target was written, the action fails and records
the affected target in `partial-failures`.

## Label synchronization and deletion

The default `orphanPolicy: keep` never deletes unrelated labels.

`fail` and `delete` apply only to existing labels matching
`managedNamePatterns` and not matching `excludeNamePatterns`. `delete` also
requires `allow-label-deletion: true`; without this second opt-in the action
fails before deletion. Deleting a GitHub label removes it from every issue and
pull request, so callers should run dry-run and review `plan` first.

## Trusted configuration boundary

For `pull_request_target`, keep `config-source: api` and omit `config-ref`. The
action reads the configuration at `pull_request.base.sha`, never from the
untrusted head checkout. On other events it defaults to the repository default
branch. An explicit `config-ref` overrides this selection.

The pull request that first introduces the action cannot safely execute its own
new write-capable config from the head branch. Merge it, run `sync-labels`
manually once, and then enable the event workflow. Do not weaken this boundary
with an untrusted checkout.

## Permissions and concurrency

Use the smallest caller permissions needed:

| Operation | Permissions |
|---|---|
| Config reads | `contents: read` |
| Issue/PR label transitions and sync | `issues: write`, `pull-requests: write` |
| Branch linking | `contents: write`, `issues: write` |
| Discussion transitions | `discussions: write` |

Serialize lifecycle mutations in the caller:

```yaml
concurrency:
  group: labels-${{ github.repository }}
  cancel-in-progress: false
```

This reduces races between release, pull request, and manual transitions. All
third-party actions in the caller should be pinned to immutable full SHAs.
