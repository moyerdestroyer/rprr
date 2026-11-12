import { expect, test } from "bun:test";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listAgentCommands, runAgent } from "../src/acp.ts";
import {
  parseReview,
  type Review,
  validateFindingLocations,
} from "../src/findings.ts";
import { loadPullRequest, restoreCheckout } from "../src/github.ts";

test("review response validates finding paths and limit", () => {
  const valid: Review = {
    summary: "Found an issue",
    findings: [
      {
        file: "src/main.ts",
        line: 3,
        severity: "high",
        title: "Broken behavior",
        message: "This fails for empty input.",
      },
    ],
  };
  expect(parseReview(JSON.stringify(valid), 1)).toEqual(valid);
  expect(
    parseReview(
      `Checking files...\n${JSON.stringify(valid)}\ntaste learning failed`,
      1,
    ),
  ).toEqual(valid);
  expect(() =>
    parseReview(`${JSON.stringify(valid)}\nStill reviewing the PR`, 1),
  ).toThrow();
  expect(() => parseReview(JSON.stringify(valid), 0)).toThrow();
  expect(() =>
    parseReview(
      JSON.stringify({
        ...valid,
        findings: [{ ...valid.findings[0], file: "../secret" }],
      }),
      1,
    ),
  ).toThrow();
});

test("PR selector rejects command options before invoking gh", async () => {
  await expect(loadPullRequest("--web")).rejects.toThrow();
});

test("finding locations must resolve to text lines inside the checkout", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "rprr-findings-test-"));
  const outside = await mkdtemp(join(tmpdir(), "rprr-outside-test-"));
  const review: Review = {
    summary: "Found an issue",
    findings: [
      {
        file: "main.ts",
        line: 2,
        severity: "high",
        title: "Issue",
        message: "Details",
      },
    ],
  };
  const finding = review.findings[0];
  if (!finding) throw new Error("Test finding is missing");
  try {
    await writeFile(join(checkout, "main.ts"), "one\ntwo\n");
    await validateFindingLocations(review, checkout);
    finding.line = 3;
    await expect(validateFindingLocations(review, checkout)).rejects.toThrow();
    await symlink(join(outside, "secret.ts"), join(checkout, "escape.ts"));
    await writeFile(join(outside, "secret.ts"), "secret\n");
    finding.file = "escape.ts";
    finding.line = 1;
    await expect(validateFindingLocations(review, checkout)).rejects.toThrow();
  } finally {
    await rm(checkout, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("ACP review can write in its disposable checkout and agent state", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "rprr-acp-test-"));
  const state = await mkdtemp(join(tmpdir(), "rprr-agent-state-test-"));
  const fixture = fileURLToPath(
    new URL("./fixtures/agent.ts", import.meta.url),
  );
  try {
    const output = await runAgent(
      {
        command: process.execPath,
        args: [fixture],
        env: { RPRR_TEST_STATE_FILE: join(state, "state.txt") },
      },
      checkout,
      "Review this change",
      10,
    );
    expect(parseReview(output, 1).summary).toBe("write succeeded; reject");
    expect(await readFile(join(checkout, "should-not-exist"), "utf8")).toBe(
      "bad",
    );
    expect(await readFile(join(state, "state.txt"), "utf8")).toBe(
      "agent state",
    );
  } finally {
    await rm(checkout, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test("checkout restoration discards agent edits before finding validation", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "rprr-restore-test-"));
  function git(...args: string[]): string {
    const result = Bun.spawnSync(["git", ...args], { cwd: checkout });
    if (result.exitCode !== 0)
      throw new Error(result.stderr.toString() || "git failed");
    return result.stdout.toString().trim();
  }
  try {
    git("init", "--quiet");
    await writeFile(join(checkout, "reviewed.txt"), "original\n");
    git("add", "reviewed.txt");
    git(
      "-c",
      "user.name=RPRR Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "base",
    );
    const head = git("rev-parse", "HEAD");
    await writeFile(join(checkout, "reviewed.txt"), "agent change\n");
    await writeFile(join(checkout, "new.txt"), "agent file\n");
    await restoreCheckout(checkout, head);
    expect(await readFile(join(checkout, "reviewed.txt"), "utf8")).toBe(
      "original\n",
    );
    await expect(access(join(checkout, "new.txt"))).rejects.toThrow();
    await expect(restoreCheckout(checkout, "invalid")).rejects.toThrow(
      /Invalid PR head/,
    );
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
});

test("the agent gets the user home unless overridden", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "rprr-acp-test-"));
  const fixture = fileURLToPath(
    new URL("./fixtures/agent.ts", import.meta.url),
  );
  try {
    const home = await runAgent(
      {
        command: process.execPath,
        args: [fixture],
        env: { RPRR_TEST_HOME: "1" },
      },
      checkout,
      "Review this change",
      10,
    );
    expect(parseReview(home, 1).summary).toBe(homedir());
    const overridden = await runAgent(
      {
        command: process.execPath,
        args: [fixture],
        env: { RPRR_TEST_HOME: "1", HOME: "/tmp" },
      },
      checkout,
      "Review this change",
      10,
    );
    expect(parseReview(overridden, 1).summary).toBe("/tmp");
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
});

test("the agent inherits the launch environment", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "rprr-acp-test-"));
  const fixture = fileURLToPath(
    new URL("./fixtures/agent.ts", import.meta.url),
  );
  process.env.RPRR_TEST_INHERITED = "environment visible";
  try {
    const output = await runAgent(
      { command: process.execPath, args: [fixture] },
      checkout,
      "Review this change",
      10,
    );
    expect(parseReview(output, 1).summary).toBe("environment visible");
  } finally {
    delete process.env.RPRR_TEST_INHERITED;
    await rm(checkout, { recursive: true, force: true });
  }
});

test("a skill is still sent when the agent advertises no commands", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "rprr-acp-test-"));
  const fixture = fileURLToPath(
    new URL("./fixtures/agent.ts", import.meta.url),
  );
  try {
    const output = await runAgent(
      {
        command: process.execPath,
        args: [fixture],
        env: { RPRR_TEST_ECHO: "1" },
      },
      checkout,
      "Review this change",
      10,
      "security-review",
    );
    expect(parseReview(output, 1).summary).toBe("/security-review");
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
});

test("a configured skill is sent as an advertised slash command", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "rprr-acp-test-"));
  const fixture = fileURLToPath(
    new URL("./fixtures/agent.ts", import.meta.url),
  );
  try {
    const output = await runAgent(
      {
        command: process.execPath,
        args: [fixture],
        env: { RPRR_TEST_ECHO: "1", RPRR_TEST_COMMANDS: "security-review" },
      },
      checkout,
      "Review this change",
      10,
      "security-review",
    );
    expect(parseReview(output, 1).summary).toBe("/security-review");
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
});

test("a configured skill must be advertised by the agent", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "rprr-acp-test-"));
  const fixture = fileURLToPath(
    new URL("./fixtures/agent.ts", import.meta.url),
  );
  try {
    await expect(
      runAgent(
        {
          command: process.execPath,
          args: [fixture],
          env: { RPRR_TEST_COMMANDS: "other" },
        },
        checkout,
        "Review this change",
        10,
        "security-review",
      ),
    ).rejects.toThrow(/\/security-review/);
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
});

test("a skill mismatch stays visible when the agent logs to stderr", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "rprr-acp-test-"));
  const fixture = fileURLToPath(
    new URL("./fixtures/agent.ts", import.meta.url),
  );
  try {
    await expect(
      runAgent(
        {
          command: process.execPath,
          args: [fixture],
          env: { RPRR_TEST_COMMANDS: "other", RPRR_TEST_STDERR: "agent log" },
        },
        checkout,
        "Review this change",
        10,
        "security-review",
      ),
    ).rejects.toThrow(/\/security-review[\s\S]*agent log/);
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
});

test("a format follow-up does not invoke the skill again", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "rprr-acp-test-"));
  const fixture = fileURLToPath(
    new URL("./fixtures/agent.ts", import.meta.url),
  );
  try {
    const output = await runAgent(
      {
        command: process.execPath,
        args: [fixture],
        env: { RPRR_TEST_NARRATE: "1", RPRR_TEST_COMMANDS: "security-review" },
      },
      checkout,
      "Review this change",
      10,
      "security-review",
    );
    expect(parseReview(output, 1).summary).toBe(
      'Complete the review now. Return only a JSON object with "summary" and "findings". Do not narrate progress.',
    );
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
});

test("skills lists the commands an agent advertises", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "rprr-acp-test-"));
  const fixture = fileURLToPath(
    new URL("./fixtures/agent.ts", import.meta.url),
  );
  try {
    const advertised = await listAgentCommands(
      {
        command: process.execPath,
        args: [fixture],
        env: { RPRR_TEST_COMMANDS: "security-review,tests" },
      },
      checkout,
      10,
    );
    expect(advertised).toEqual([
      { name: "security-review", description: "security-review skill" },
      { name: "tests", description: "tests skill" },
    ]);
    expect(
      await listAgentCommands(
        { command: process.execPath, args: [fixture] },
        checkout,
        10,
      ),
    ).toEqual([]);
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
});
