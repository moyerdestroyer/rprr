<p align="center"><img src="assets/mascot-v2.png" alt="RPRR mascot: a blonde, masked reviewer inspecting a pull request through a magnifying glass" width="220"></p>

# rprr

Ryan's PR Reviewer is a local-first CLI for reviewing GitHub pull requests through a configurable [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) coding agent. It uses your existing `gh` login. Automated polling is under development.

## Current state

`init` creates local configuration and an empty SQLite review database. `doctor` checks dependencies and configuration. `review` checks out a PR at its observed head, runs an ACP review in a read-only sandbox, validates the JSON response, and prints a dry run. `review --publish` submits a non-approving `COMMENT` review after checking the PR head and inline locations again. `poll` and `status` are not available yet.

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

Until the package is published, `bun link` makes the CLI available globally from this checkout. The package has a Bun shebang and a `bin` entry; publishing will allow `bun add -g rprr`.

## Configure

```bash
rprr init --agent-command <executable> --agent-arg <first-argument>
rprr doctor
rprr review 123
# or: rprr review https://github.com/OWNER/REPO/pull/123
rprr review 123 --publish  # explicitly submit a COMMENT review
```

Without `--agent-command`, `init` prompts for an executable in a terminal. Repeat `--agent-arg` for each argument. `init` requires an authenticated `gh` session and refuses to overwrite an existing config file. Edit the JSON file to change the command, arguments, or review settings later. The agent is launched only by `review`. Set `agent.env` in the config if the sandboxed agent needs credentials from environment variables or a specific `HOME` for its login. For Command Code, `--no-session --no-auto-update acp` works as the agent arguments.

Example configuration:

```json
{
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

The database schema is a starting point for later review history. No review jobs are written by the current CLI. Publication requires both `review.publish: true` in the config and an explicit `--publish` flag. Running it again can post a duplicate review; deduplication belongs to the planned polling phase.

## Planned workflow

1. `review <PR>` inspects a PR in a temporary checkout through an ACP agent and validates structured findings.
2. Optional publication rechecks the PR head and base, verifies that each inline finding is on an added line, and submits a `COMMENT` review through `gh`.
3. `poll` will discover explicit review requests, avoid duplicate reviews, retry failures, and exit after one run. Scheduling will remain external.
4. `status` will show recent and failed jobs.

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
```

## Roadmap

- [x] Phase 1: package, executable, XDG config/state, `init`, and basic `doctor`
- [x] Phase 2: manual ACP review and dry-run output
- [x] Phase 3: validated GitHub review publication
- [ ] Phase 4: idempotent review-request polling
- [ ] Phase 5: systemd user timer or cron documentation

Coverage currently reports only modules loaded by the tests, so the CLI is not included in its percentage yet. There is no coverage threshold until CLI tests make that metric representative.

The original development brief defines the v0.1 acceptance criteria. The Phase 1 commands alone do not satisfy them.
