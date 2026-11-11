# Pull request review

Inspect the checked-out repository and the pull request changes. Report actionable defects supported by evidence in the code. Investigate surrounding code when needed.

Focus on behavioral regressions, security issues, incorrect assumptions, broken integrations, and material performance problems. Mention missing tests only when they expose a specific risk in changed behavior. Skip speculative concerns, formatting, and style preferences.

Return a JSON object with `summary` and `findings`. Each finding needs `file`, `line`, `severity`, `title`, and `message`. Do not modify the repository.
