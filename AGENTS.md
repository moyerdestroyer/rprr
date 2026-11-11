# Working on RPRR

## Local checks

- After every code change, run `bun run check` and fix all failures before committing or pushing. This runs strict TypeScript, Biome lint/format/complexity checks, Knip dead-code and cycle checks, and Bun tests with coverage.
- After changing dependencies or `bun.lock`, also run `bun run audit`. It requires network access.
- Add tests for changed behavior and meaningful failure paths. Read the coverage report, but do not treat its percentage as whole-project coverage until tests load the CLI.

## Architecture and factoring

- Keep CLI argument handling and orchestration thin. Separate configuration/state, GitHub operations, ACP execution, finding validation, and review publication behind focused modules.
- Validate data at external boundaries. Keep review decisions deterministic and make publication recheck the PR head and inline locations. Never approve, merge, or modify a PR; agent execution must use an explicit read-only permission policy.
- Prefer small functions with one clear responsibility and explicit inputs/outputs. Extract shared logic when it removes real duplication or clarifies a boundary; avoid speculative abstractions, circular imports, and unused exports.
