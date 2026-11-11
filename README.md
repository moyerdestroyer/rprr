<p align="center"><img src="assets/mascot-v3.png" alt="RPRR mascot: a blonde, masked reviewer inspecting a pull request through a magnifying glass" width="220"></p>

# rprr

Ryan's PR Reviewer is a local-first CLI for reviewing GitHub pull requests through a configurable [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) coding agent. It uses your existing `gh` login.

## What it does

RPRR checks out a pull request at its observed head and asks an ACP agent to review it in a read-only sandbox. `review` prints a dry run; `review --publish` can submit a non-approving `COMMENT` review after rechecking the PR. `poll` processes direct review requests once, and `status` reports health, review history, and timer state.

## Requirements

- [Bun](https://bun.sh/)
- [Git](https://git-scm.com/)
- [GitHub CLI](https://cli.github.com/), authenticated with `gh auth login`
- Linux with [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) for `review`
- An ACP-compatible coding agent, installed and authenticated separately

## Install from source

```bash
git clone https://github.com/moyerdestroyer/rprr.git
cd rprr
bun install
bun run check
bun link
rprr --help
```

Until the package is published, `bun link` makes the CLI available from this checkout. The package includes its docs and systemd examples; publishing will allow `bun add -g rprr`.

## Get started

```bash
rprr setup --agent-command cmd --agent-arg --no-session --agent-arg --no-auto-update --agent-arg acp
rprr doctor --deep
rprr config show
rprr config validate
rprr config set review.maxFindings 20
rprr review https://github.com/OWNER/REPO/pull/123
rprr setup --publish       # explicitly enable publication
rprr review https://github.com/OWNER/REPO/pull/123 --publish
rprr poll                  # process direct review requests once
rprr status                # health, last poll, service, and recent jobs
rprr service install       # install local timer, disabled
rprr service enable        # explicitly start automatic polling
```

`setup` can be rerun safely. It accepts `--dry-run` to preview changes and probes the ACP agent before saving. New configurations start with publication disabled; `rprr setup --publish` enables it. Repeat `--agent-arg` for each argument. Without `--agent-command`, setup reuses an existing command or prompts in a terminal. `init` remains an alias.

Use `rprr config show|validate|set|edit` for later changes. Updates are written atomically with the previous file saved as `config.json.bak`; `config show` redacts `agent.env` values. Set `VISUAL` or `EDITOR` to an executable path for `config edit`. If the sandboxed agent needs credentials or a specific `HOME`, configure `agent.env`. For Command Code, use `--no-session --no-auto-update acp` as the agent arguments. `--skip-agent-probe` is available when you need to save the config before troubleshooting the agent.

Example configuration:

```json
{
  "schemaVersion": 1,
  "agent": {
    "command": "cmd",
    "args": ["--no-session", "--no-auto-update", "acp"]
  },
  "github": { "trigger": "review-request" },
  "review": { "publish": false, "timeoutSeconds": 900, "maxFindings": 20 }
}
```

Mutable data follows XDG paths. `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` are respected when set:

| Purpose        | Default location                     |
| -------------- | ------------------------------------ |
| Config         | `~/.config/rprr/config.json`         |
| Review state   | `~/.local/state/rprr/reviews.sqlite` |
| Reserved cache | `~/.cache/rprr/`                     |

Polling requires `review.publish: true` in the config. Manual publication requires that setting and an explicit `--publish` flag. Before posting, publication checks GitHub for an existing RPRR `COMMENT` review on the same head. Polling records one claim per repository, PR, and head in SQLite, retries failures, and reconciles posted reviews after interrupted runs. A new head is eligible for a new review. `poll` exits after one pass; run it manually or schedule it locally. It handles direct requests for the signed-in `gh` user, not team review requests.

For recurring local runs, see the [systemd user timer and cron setup](docs/scheduling.md). Scheduling is opt-in and runs under your own account.

## Safety

RPRR never approves, merges, or modifies a PR. Before publication it rechecks the PR head and base and validates inline comment locations. The agent runs with read-only access to the host filesystem and a writable temporary directory; ACP permission requests allow reads and searches and reject edits. The sandbox does not hide readable host files or block network access, so use a trusted agent and take care with its credentials. RPRR does not run PR code itself.

## Quality checks

```bash
bun run check          # types, Biome, Knip, and tests with coverage
bun run format         # apply Biome formatting
bun run audit          # audit locked dependencies (network required)
bun run package:check  # pack and test an isolated global installation
```

GitHub Actions runs the local quality gate, dependency audit, and packed global installation as separate checks on pushes to `main`, pull requests, and manual dispatch. It uses the pinned Bun version in `.bun-version` and `bun ci` for lockfile reproducibility. The workflow has read-only repository permission and never runs `rprr poll` or publishes reviews. Validate workflow edits locally with `actionlint .github/workflows/*.yml`.

Coverage percentages include modules loaded by in-process tests. CLI lifecycle tests run in subprocesses, so their execution is not counted in that report.

<p align="center"><img src="assets/mascot-banner-v2.png" alt="RPRR's masked blonde reviewer reclining on a burgundy chaise, with one boot on each leg" width="100%"></p>
