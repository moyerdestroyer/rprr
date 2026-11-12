<p align="center"><img src="assets/mascot-v3.png" alt="RPRR mascot: a blonde, masked reviewer inspecting a pull request through a magnifying glass" width="220"></p>

# rprr

Ryan's PR Reviewer is a local-first CLI for reviewing GitHub pull requests through a configurable [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) coding agent. It uses your existing `gh` login.

## What it does

RPRR checks out a pull request at its observed head and asks an ACP agent to review it in a disposable checkout. `review` creates a pending GitHub review by default. `review --publish` submits an existing draft or posts a new non-approving `COMMENT` review; `review --dry-run` previews without posting. `poll` creates drafts for direct review requests, and `drafts` lists locally tracked pending reviews.

## Requirements

- Linux
- [Git](https://git-scm.com/)
- [GitHub CLI](https://cli.github.com/), authenticated with `gh auth login`
- An ACP-compatible coding agent, installed and authenticated separately
- [Bun](https://bun.sh/), only when running from a source checkout

## Install

```bash
curl -fsSL https://github.com/moyerdestroyer/rprr/releases/latest/download/install.sh | bash
```

The script installs the latest Linux x64 or arm64 release into `~/.local/bin` and adds that directory to your bash or zsh startup file when it is not already on `PATH`. It checks dependencies, and on a first run starts `rprr setup`. In a terminal, setup asks which agent to use and whether to check for review requests every 15 minutes. Run the same command again to update. An update keeps the existing configuration and refreshes a generated systemd unit when the binary changes.

## Install from source

```bash
git clone https://github.com/moyerdestroyer/rprr.git
cd rprr
bun install
bun run check
bun link
rprr --help
```

`bun link` makes this checkout available as `rprr`. The install script above is the supported way to give the command to someone else.

## Get started

```bash
rprr setup                     # choose any installed ACP agent and its arguments
rprr doctor --deep
rprr config show
rprr config validate
rprr config set review.maxFindings 20
rprr review https://github.com/OWNER/REPO/pull/123 --dry-run
rprr review https://github.com/OWNER/REPO/pull/123            # create a draft
rprr review https://github.com/OWNER/REPO/pull/123 --publish  # submit the draft
rprr poll                  # draft direct review requests once
rprr drafts                # list locally tracked pending reviews
rprr status                # health, last poll, service, and recent jobs
rprr service install       # install local timer, disabled
rprr service enable        # explicitly start automatic polling
```

`setup` can be rerun safely. In a terminal, it detects installed agents with known ACP launch commands, verifies each with an ACP handshake, and offers them alongside a custom command or path. The custom option accepts any ACP-compatible executable and its arguments. If no arguments are given and the agent does not speak ACP directly, setup tries the common `acp` subcommand. Discovery only checks known local executables and does not install agents or run model prompts. `--dry-run` previews without probing; `--skip-agent-probe` saves without discovery or verification. Repeat `--agent-arg` for each argument in a non-interactive setup. Setup resolves the executable to an absolute path so scheduled runs use the same installation. Pass `--agent-command` for a non-interactive setup; without a terminal it reuses an existing command. `init` remains an alias.

Use `rprr config show|validate|set|edit` for later changes. Updates are written atomically with the previous file saved as `config.json.bak`; `config show` redacts `agent.env` values. Set `VISUAL` or `EDITOR` to an executable path for `config edit` and `prompt edit`. The agent inherits the launch environment, including `HOME` and `PATH`, so existing login and state remain available. `agent.env` overrides that environment. `--skip-agent-probe` is available when you need to save the config before troubleshooting the agent.

`rprr prompt show` prints the review instructions. `rprr prompt edit` saves a copy at `~/.config/rprr/prompt.md` and opens it. `rprr prompt reset` returns to the built-in instructions. `rprr config set review.promptFile /absolute/path.md` uses another file, and an empty value clears it. RPRR still appends the instruction to return JSON and to treat the pull request as untrusted data.

ACP agents can advertise slash commands, which is how agents such as Claude Code and Copilot expose skills. `rprr skills` prints the commands the configured agent advertises. `rprr config set review.skill security-review` invokes `/security-review` and passes the review prompt as its input. If the agent advertises commands and that name is not among them, the review stops. If it advertises none, RPRR still sends the slash command. Set the value to empty to clear it.

Example configuration:

```json
{
  "schemaVersion": 1,
  "agent": {
    "command": "/home/you/.local/bin/your-acp-agent",
    "args": ["acp"]
  },
  "github": { "trigger": "review-request" },
  "review": { "timeoutSeconds": 900, "maxFindings": 20 }
}
```

Mutable data follows XDG paths. `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` are respected when set:

| Purpose         | Default location                     |
| --------------- | ------------------------------------ |
| Config          | `~/.config/rprr/config.json`         |
| Prompt override | `~/.config/rprr/prompt.md`           |
| Review state    | `~/.local/state/rprr/reviews.sqlite` |
| Reserved cache  | `~/.cache/rprr/`                     |

Polling finds open PRs that currently request a review from the signed-in `gh` user, including requests made before RPRR was installed. It creates a pending GitHub review, with draft inline comments, for each new PR head. A pending review is not submitted publicly until you run `rprr review PR --publish` or submit it on GitHub. `--publish` also posts a new review directly when no draft exists; it never approves or requests changes. Before posting, RPRR rechecks the PR head and base and validates inline locations. Polling records one claim per repository, PR, and head in SQLite, retries failures, and reconciles reviews after interrupted runs. It handles direct requests, not team review requests.

GitHub sends the reviewer its usual review-request notification. After RPRR creates a draft, it attempts a local desktop notification with the RPRR mascot icon via `notify-send` when available. A background timer or cron job may run without a desktop notification session, so the toast is best effort. `rprr drafts` and `rprr status` show locally tracked drafts even if no toast appears. `rprr poll` runs one pass immediately; the timer checks every 15 minutes.

For recurring local runs, see the [systemd user timer and cron setup](docs/scheduling.md). Scheduling is opt-in and runs under your own account.

## Safety

RPRR never approves, merges, or modifies a PR. Before publication it rechecks the PR head and base and validates inline comment locations against the original checkout. Agent changes to the temporary checkout are discarded before findings are validated. ACP permission requests allow reads and searches and reject edits. Agents run with your account's normal filesystem and network access, so use a trusted agent and take care with its credentials. RPRR does not run PR code itself.

## Release

Push a git tag `vX.Y.Z` that matches the `version` in `package.json`. GitHub Actions builds glibc binaries for Linux x64 and arm64, writes `SHA256SUMS`, and attaches those files plus `scripts/install.sh` to the GitHub Release.

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
