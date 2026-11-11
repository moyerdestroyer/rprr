<p align="center"><img src="assets/mascot-v3.png" alt="RPRR mascot: a blonde, masked reviewer inspecting a pull request through a magnifying glass" width="220"></p>

# rprr

Ryan's PR Reviewer is a local-first CLI for reviewing GitHub pull requests through a configurable [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) coding agent. It uses your existing `gh` login.

## Current state

`setup` creates or updates local configuration and initializes SQLite state. `doctor --deep` probes the ACP agent in a read-only sandbox. `review` checks out a PR at its observed head, runs a review, and prints a dry run. `review --publish` submits a non-approving `COMMENT` review after rechecking the PR head and inline locations. `poll` processes direct review requests once. `status` reports health, the last poll, recent jobs, and the local timer.

## Requirements

- [Bun](https://bun.sh/)
- [Git](https://git-scm.com/)
- [GitHub CLI](https://cli.github.com/), authenticated with `gh auth login`
- Linux with [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) for `review`
- An ACP-compatible coding agent, installed and authenticated separately

## Develop locally

```bash
git clone https://github.com/moyerdestroyer/rprr.git
cd rprr
bun install
bun run check
bun link
rprr --help
```

Until the package is published, `bun link` makes the CLI available globally from this checkout. The package includes its docs and systemd examples; publishing will allow `bun add -g rprr`. Run `bun run package:check` before release to pack it and start the CLI in an isolated home directory.

## Configure

```bash
rprr setup --agent-command <executable> --agent-arg <first-argument>
rprr doctor --deep
rprr config show
rprr config validate
rprr config set review.maxFindings 20
rprr review 123
# or: rprr review https://github.com/OWNER/REPO/pull/123
rprr review 123 --publish  # explicitly submit a COMMENT review
rprr poll                  # process direct review requests once
rprr status                # health, last poll, service, and recent jobs
rprr service install       # install local timer, disabled
rprr service enable        # explicitly start automatic polling
```

`setup` can be rerun safely and accepts `--dry-run` to preview. It probes the configured ACP agent before saving; use `--skip-agent-probe` only when you intend to diagnose it later. New configurations start with publication disabled. Enable it explicitly with `rprr setup --publish` before automatic polling. Repeat `--agent-arg` for each argument. Without `--agent-command`, setup reuses an existing command or prompts in a terminal. `init` remains an alias. Use `rprr config show|validate|set|edit` for later changes; updates are written atomically and the prior file is saved as `config.json.bak`. `config show` redacts `agent.env` values. Set `VISUAL` or `EDITOR` to an executable path for `config edit`. Set `agent.env` in the config if the sandboxed agent needs credentials or a specific `HOME`. For Command Code, `--no-session --no-auto-update acp` works as the agent arguments.

Example configuration:

```json
{
  "schemaVersion": 1,
  "agent": { "command": "cmd", "args": ["acp"] },
  "github": { "trigger": "review-request" },
  "review": { "publish": true, "timeoutSeconds": 900, "maxFindings": 20 }
}
```

Mutable data follows XDG paths. `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` are respected when set:

| Purpose                  | Default location                     |
| ------------------------ | ------------------------------------ |
| Config                   | `~/.config/rprr/config.json`         |
| Review state             | `~/.local/state/rprr/reviews.sqlite` |
| Cache and temporary data | `~/.cache/rprr/`                     |

Polling requires `review.publish: true` in the config. Manual publication requires that setting and an explicit `--publish` flag. Before posting, publication checks GitHub for an existing RPRR `COMMENT` review on the same head. Polling records one claim per repository, PR, and head in SQLite, retries failures, and reconciles posted reviews after interrupted runs. A new head is eligible for a new review. `poll` exits after one pass; run it manually or schedule it locally. It handles direct requests for the signed-in `gh` user, not team review requests.

For recurring local runs, see the [systemd user timer and cron setup](docs/scheduling.md). Scheduling is opt-in and runs under your own account.

## Planned workflow

1. `review <PR>` inspects a PR in a temporary checkout through an ACP agent and validates structured findings.
2. Optional publication rechecks the PR head and base, verifies that each inline finding is on an added line, and submits a `COMMENT` review through `gh`.
3. `poll` discovers direct review requests, avoids duplicate reviews, retries failures, and exits after one run. Scheduling remains external.
4. `status` shows recent jobs and their errors.

The architecture keeps GitHub orchestration, agent execution, and publication separate. Reviews must never approve, merge, or modify a PR. The review sandbox mounts the host filesystem read-only and gives the agent only a writable temporary directory. ACP permission requests allow reads and searches and reject edits. ACP permissions are advisory; the sandbox does not hide readable host files or block network access, so use a trusted agent and take care with its credentials. The CLI does not run PR code itself.

## Quality checks

```bash
bun run typecheck  # strict TypeScript
bun run lint       # Biome lint, complexity, and formatting check
bun run format     # apply formatting
bun run knip       # unused files, exports, dependencies, and import cycles
bun run coverage   # Bun tests with coverage report
bun run audit      # check lockfile for known vulnerabilities (requires network)
bun run check      # local offline checks: types, Biome, Knip, and tests
bun run package:check # pack and smoke test an isolated installation
```

GitHub Actions runs the local quality gate, dependency audit, and packed global installation as separate checks on pushes to `main`, pull requests, and manual dispatch. It uses the pinned Bun version in `.bun-version` and `bun ci` for lockfile reproducibility. The workflow has read-only repository permission and never runs `rprr poll` or publishes reviews. Validate workflow edits locally with `actionlint .github/workflows/*.yml`.

## Roadmap

- [x] Phase 1: package, executable, XDG config/state, `init`, and basic `doctor`
- [x] Phase 2: manual ACP review and dry-run output
- [x] Phase 3: validated GitHub review publication
- [x] Phase 4: idempotent review-request polling
- [x] Phase 5: systemd user timer or cron documentation

Coverage currently reports only modules loaded by the tests, so the CLI is not included in its percentage yet. There is no coverage threshold until CLI tests make that metric representative.

The original development brief defines the v0.1 acceptance criteria. The Phase 1 commands alone do not satisfy them.
