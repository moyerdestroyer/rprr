<p align="center"><img src="assets/mascot-v2.png" alt="RPRR mascot: a blonde, masked reviewer inspecting a pull request through a magnifying glass" width="220"></p>

# rprr

Ryan's PR Reviewer is a local-first CLI for reviewing GitHub pull requests through a configurable [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) coding agent. It uses your existing `gh` login and is designed to publish non-approving reviews. The automation workflow is under development.

## Current state

The Phase 1 foundation is implemented: `init` creates local configuration and an empty SQLite review database; `doctor` checks installed executables, GitHub authentication, configuration, and whether the configured agent executable is on `PATH`. ACP connectivity is not yet tested. `review`, `poll`, and `status` are planned and are not available yet.

## Requirements

- [Bun](https://bun.sh/)
- [Git](https://git-scm.com/)
- [GitHub CLI](https://cli.github.com/), authenticated with `gh auth login`
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
```

Without `--agent-command`, `init` prompts for an executable in a terminal. Repeat `--agent-arg` for each argument. `init` requires an authenticated `gh` session and refuses to overwrite an existing config file. Edit the JSON file to change the command, arguments, or review settings later. The configured agent is not launched by `init` or `doctor` yet.

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

The database schema is a starting point for later review history. No review jobs are written by the current CLI.

## Planned workflow

1. `review <PR>` will inspect a PR in a temporary checkout through an ACP agent and validate structured findings.
2. Publication will recheck the PR head, verify inline locations, and submit a `COMMENT` review through `gh`.
3. `poll` will discover explicit review requests, avoid duplicate reviews, retry failures, and exit after one run. Scheduling will remain external.
4. `status` will show recent and failed jobs.

The architecture keeps GitHub orchestration, agent execution, and publication separate. Reviews must never approve, merge, or modify a PR. ACP permission requests will require an explicit read-only policy before agent execution is enabled; a temporary checkout alone does not secure untrusted repository content.

## Quality checks

```bash
bun run typecheck  # strict TypeScript
bun run lint       # Biome lint and formatting check
bun run format     # apply formatting
bun test           # Bun tests
bun run check      # all checks
```

## Roadmap

- [x] Phase 1: package, executable, XDG config/state, `init`, and basic `doctor`
- [ ] Phase 2: manual ACP review and dry-run output
- [ ] Phase 3: validated GitHub review publication
- [ ] Phase 4: idempotent review-request polling
- [ ] Phase 5: systemd user timer or cron documentation

The original development brief defines the v0.1 acceptance criteria. The Phase 1 commands alone do not satisfy them.
