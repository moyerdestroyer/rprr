import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import mascot from "../assets/mascot.txt" with { type: "text" };
import { pollLaunch, renderUnits } from "../src/service.ts";
import { ReviewStore } from "../src/state.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "rprr-lifecycle-"));
  temporary.push(home);
  const bin = join(home, "bin");
  await mkdir(bin);
  for (const [name, script] of [
    ["gh", '#!/bin/sh\n[ "$1" = auth ] && exit 0\nexit 1\n'],
    [
      "systemctl",
      '#!/bin/sh\necho "$*" >> "$RPRR_TEST_CALLS"\ncase "$*" in *is-enabled*) echo disabled;; *is-active*) echo inactive;; esac\n',
    ],
    ["systemd-analyze", "#!/bin/sh\nexit 0\n"],
    [
      "rprr-test-editor",
      '#!/bin/sh\nsed -i \'s/"maxFindings": 7/"maxFindings": 8/\' "$1"\n',
    ],
  ] as const) {
    const path = join(bin, name);
    await writeFile(path, script);
    await chmod(path, 0o755);
  }
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    PATH: `${bin}:${process.env.PATH}`,
    RPRR_TEST_CALLS: join(home, "systemctl.log"),
    VISUAL: join(bin, "rprr-test-editor"),
  };
  const config = join(env.XDG_CONFIG_HOME, "rprr", "config.json");
  async function cli(...args: string[]) {
    const child = Bun.spawn([process.execPath, "bin/rprr.ts", ...args], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  }
  return { home, env, config, cli };
}

test("repeatable setup and service lifecycle stay inside an isolated home", async () => {
  const { home, env, config, cli } = await fixture();
  const agent = process.execPath;
  expect((await cli("setup", "--agent-command", agent, "--dry-run")).code).toBe(
    0,
  );
  await expect(readFile(config)).rejects.toThrow();
  expect(
    (await cli("setup", "--agent-command", agent, "--skip-agent-probe")).code,
  ).toBe(0);
  expect(
    JSON.parse(await readFile(config, "utf8")).review.publish,
  ).toBeUndefined();
  expect((await cli("setup", "--skip-agent-probe")).stdout).toContain(
    "Configuration unchanged",
  );
  expect((await cli("service", "install")).code).toBe(0);
  const unit = await readFile(
    join(env.XDG_CONFIG_HOME, "systemd", "user", "rprr.service"),
    "utf8",
  );
  expect(unit).toContain("ExecStart=");
  expect(unit).toContain("bin/rprr.ts");
  expect(unit).toContain(binPath(env.PATH));
  expect((await cli("service", "enable")).code).toBe(0);
  expect((await cli("config", "set", "review.maxFindings", "7")).code).toBe(0);
  expect(
    JSON.parse(await readFile(`${config}.bak`, "utf8")).review.maxFindings,
  ).toBe(20);
  expect((await cli("config", "edit")).code).toBe(0);
  expect(JSON.parse(await readFile(config, "utf8")).review.maxFindings).toBe(8);
  const withSecret = JSON.parse(await readFile(config, "utf8"));
  withSecret.agent.env = { TOKEN: "secret-sentinel" };
  await writeFile(config, JSON.stringify(withSecret));
  expect((await cli("config", "show")).stdout).not.toContain("secret-sentinel");
  expect((await cli("config", "validate")).code).toBe(0);
  expect((await cli("config", "set", "review.publish", "maybe")).code).toBe(1);
  expect((await cli("service", "enable")).code).toBe(0);
  const status = JSON.parse((await cli("status", "--json")).stdout);
  expect(status.service.installed).toBe(true);
  expect(status.jobs).toEqual([]);
  expect((await cli("service", "uninstall")).code).toBe(0);
  expect((await cli("service", "status")).stdout).toContain(
    '"installed": false',
  );
  const calls = await readFile(join(home, "systemctl.log"), "utf8");
  expect(calls).toContain("enable --now rprr.timer");
  expect(calls).toContain("disable --now rprr.timer");
  await writeFile(
    join(env.XDG_CONFIG_HOME, "systemd", "user", "rprr.service"),
    "[Service]\nExecStart=/bin/true\n",
  );
  expect((await cli("service", "install")).code).toBe(1);
});

test("deep doctor validates an ACP agent with the normal launch environment", async () => {
  const { cli } = await fixture();
  const agent = fileURLToPath(new URL("./fixtures/agent.ts", import.meta.url));
  const setup = await cli(
    "setup",
    "--agent-command",
    process.execPath,
    "--agent-arg",
    agent,
  );
  expect(setup.code, setup.stderr).toBe(0);
  const doctor = await cli("doctor", "--deep");
  expect(doctor.code).toBe(0);
  expect(doctor.stdout).toContain("✓ ACP handshake");
});

test("generated unit quotes executable paths and preserves custom agent path", () => {
  const units = renderUnits(
    ["/opt/bun/bin/bun", "/opt/rprr/bin/rprr.ts", "poll"],
    "/opt/agent/bin/acp-reviewer",
    "/usr/bin/gh",
  );
  expect(units.service).toContain(
    'ExecStart="/opt/bun/bin/bun" "/opt/rprr/bin/rprr.ts" "poll"',
  );
  expect(units.service).toContain("/opt/agent/bin");
  expect(units.service).toContain(
    (process.env.PATH ?? "")
      .split(":")
      .find((entry) => entry.includes(".bun/bin")) ?? "/usr/bin",
  );
  expect(units.timer).toContain("Persistent=true");
  const standalone = renderUnits(
    ["/home/user/.local/bin/rprr", "poll"],
    "/opt/agent/bin/acp-reviewer",
    "/usr/bin/gh",
  );
  expect(standalone.service).toContain(
    'ExecStart="/home/user/.local/bin/rprr" "poll"',
  );
  expect(standalone.service).toContain("/home/user/.local/bin");
  expect(
    pollLaunch(true, undefined, "/home/user/.local/bin/rprr", "/ignored"),
  ).toEqual(["/home/user/.local/bin/rprr", "poll"]);
  expect(
    pollLaunch(
      false,
      "/opt/bun/bin/bun",
      "/opt/bun/bin/bun",
      "/src/bin/rprr.ts",
    ),
  ).toEqual(["/opt/bun/bin/bun", "/src/bin/rprr.ts", "poll"]);
  expect(() => pollLaunch(false, undefined, "/x", "/y")).toThrow(/bun/);
});

function binPath(path: string): string {
  return path.split(":")[0] ?? "";
}

test("setup resolves an agent on PATH to a stable executable path", async () => {
  const { home, config, cli } = await fixture();
  const agent = join(home, "bin", "other-acp-agent");
  await writeFile(agent, "#!/bin/sh\nexit 0\n");
  await chmod(agent, 0o755);
  const result = await cli(
    "setup",
    "--agent-command",
    "other-acp-agent",
    "--agent-arg",
    "acp",
    "--skip-agent-probe",
  );
  expect(result.code).toBe(0);
  expect(JSON.parse(await readFile(config, "utf8")).agent.command).toBe(agent);
  expect(
    (await cli("setup", "--agent-command", agent, "--skip-agent-probe")).code,
  ).toBe(0);
  expect(JSON.parse(await readFile(config, "utf8")).agent.args).toEqual([
    "acp",
  ]);
});

test("a differently named ACP executable works through setup and doctor", async () => {
  const { config, cli } = await fixture();
  const temporaryDirectory = await mkdtemp(join(root, ".rprr-agent-tools-"));
  temporary.push(temporaryDirectory);
  const directory = join(temporaryDirectory, "agent tools");
  await mkdir(directory);
  const executable = join(directory, "alternate reviewer");
  const fixtureAgent = fileURLToPath(
    new URL("./fixtures/agent.ts", import.meta.url),
  );
  await writeFile(
    executable,
    `#!/bin/sh\nexec "${process.execPath}" "${fixtureAgent}" "$@"\n`,
  );
  await chmod(executable, 0o755);
  const setup = await cli("setup", "--agent-command", executable);
  if (setup.code !== 0) throw new Error(setup.stderr);
  expect(setup.code).toBe(0);
  expect(JSON.parse(await readFile(config, "utf8")).agent.command).toBe(
    executable,
  );
  const doctor = await cli("doctor", "--deep");
  expect(doctor.code).toBe(0);
  expect(doctor.stdout).toContain("✓ ACP handshake");
});

test("setup discovers an ACP subcommand and keeps explicit arguments strict", async () => {
  const { home, config, cli } = await fixture();
  const executable = join(home, "bin", "subcommand-agent");
  const fixtureAgent = fileURLToPath(
    new URL("./fixtures/agent.ts", import.meta.url),
  );
  await writeFile(
    executable,
    `#!/bin/sh\nif [ "$1" != acp ]; then\n  echo 'Interactive mode requires a TTY terminal.' >&2\n  exit 1\nfi\nshift\nexec "${process.execPath}" "${fixtureAgent}" "$@"\n`,
  );
  await chmod(executable, 0o755);
  const setup = await cli("setup", "--agent-command", executable);
  expect(setup.code, setup.stderr).toBe(0);
  expect(setup.stdout).toContain('"acp"');
  expect(JSON.parse(await readFile(config, "utf8")).agent.args).toEqual([
    "acp",
  ]);
  expect((await cli("doctor", "--deep")).code).toBe(0);
  const wrong = await cli(
    "setup",
    "--agent-command",
    executable,
    "--agent-arg",
    "wrong",
  );
  expect(wrong.code).toBe(1);
  expect(wrong.stderr).toContain("TTY terminal");
  expect(JSON.parse(await readFile(config, "utf8")).agent.args).toEqual([
    "acp",
  ]);
});

test("setup without a terminal requires an agent command", async () => {
  const { config, cli } = await fixture();
  const result = await cli("setup");
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("--agent-command");
  await expect(readFile(config)).rejects.toThrow();
});

test("drafts command lists locally recorded pending reviews", async () => {
  const { env, cli } = await fixture();
  const store = await ReviewStore.open(
    join(env.XDG_STATE_HOME, "rprr", "reviews.sqlite"),
  );
  try {
    store.recordPosted("org/repo", 12, "a".repeat(40), 52, "PENDING");
  } finally {
    store.close();
  }
  const drafts = await cli("drafts");
  expect(drafts.code).toBe(0);
  expect(drafts.stdout).toContain("1 draft to review");
  expect(drafts.stdout).toContain("1. org/repo#12");
  expect(drafts.stdout).toContain(
    "https://github.com/org/repo/pull/12#pullrequestreview-52",
  );
  expect(drafts.stdout).toContain("--publish");
  expect(drafts.stdout).not.toContain("a".repeat(40));
  expect(drafts.stdout).not.toContain("\u001b");
  expect(JSON.parse((await cli("drafts", "--json")).stdout)).toMatchObject([
    {
      url: "https://github.com/org/repo/pull/12",
      reviewUrl: "https://github.com/org/repo/pull/12#pullrequestreview-52",
      reviewId: 52,
    },
  ]);
});

test("setup rejects broken authentication and a missing agent without writing config", async () => {
  const { home, config, cli } = await fixture();
  await writeFile(join(home, "bin", "gh"), "#!/bin/sh\nexit 1\n");
  expect((await cli("setup", "--agent-command", process.execPath)).code).toBe(
    1,
  );
  await expect(readFile(config)).rejects.toThrow();
  await writeFile(
    join(home, "bin", "gh"),
    '#!/bin/sh\n[ "$1" = auth ] && exit 0\nexit 1\n',
  );
  expect((await cli("setup", "--agent-command", "/missing/agent")).code).toBe(
    1,
  );
  await expect(readFile(config)).rejects.toThrow();
});

test("empty drafts and status offer clear next steps without configuration", async () => {
  const { cli } = await fixture();
  expect((await cli("drafts")).stdout).toContain("No locally tracked drafts.");
  expect((await cli("drafts")).stdout).toContain("rprr poll");
  expect(JSON.parse((await cli("drafts", "--json")).stdout)).toEqual([]);
  const status = await cli("status");
  expect(status.code).toBe(0);
  expect(status.stdout).toContain("RPRR / Needs attention");
  expect(status.stdout).toContain("Last poll: not run yet");
  expect(status.stdout).toContain("Health: rprr doctor");
  expect(status.stdout).toContain("0 drafts ready");
  expect(status.stdout).not.toContain('"jobs"');
  expect((await cli("status", "--failures")).stdout).toContain("No failed PRs");
});

test("status summarizes all current PRs and provides local failure inspection", async () => {
  const { env, cli } = await fixture();
  const store = await ReviewStore.open(
    join(env.XDG_STATE_HOME, "rprr", "reviews.sqlite"),
  );
  const error =
    "Agent timed out\nCheck agent credentials before retrying.\n\u001b[31mAgent detail\u001b[0m";
  try {
    const failed = store.claim("org/repo", 12, "failed-head", "ryan", 30);
    const blocked = store.claim("org/repo", 13, "blocked-head", "ryan", 30);
    const recovered = store.claim("org/repo", 14, "old-head", "ryan", 30);
    if (!failed || !blocked || !recovered) throw new Error("Missing claims");
    store.fail(failed, error);
    store.fail(blocked, "Review budget exceeded", "budget-key");
    store.fail(recovered, "Old error that should be hidden");
    store.recordPosted("org/repo", 14, "new-head", 53, "PENDING");
    for (let number = 20; number < 45; number++)
      store.recordPosted(
        "org/repo",
        number,
        "done-head",
        number + 100,
        "COMMENTED",
      );
    store.recordPosted("org/repo", 15, "draft-head", 54, "PENDING");
    store.claim("org/repo", 16, "running-head", "ryan", 30);
    const poll = store.startPoll();
    store.finishPoll(poll, {
      discovered: 4,
      completed: 2,
      skipped: 0,
      failed: 2,
    });
  } finally {
    store.close();
  }
  const summary = await cli("status");
  expect(summary.code).toBe(0);
  expect(summary.stdout).toContain("RPRR / Needs attention");
  expect(summary.stdout).toContain(
    "2 drafts ready / 1 reviewing / 2 need attention",
  );
  expect(summary.stdout).toContain("rprr status --failures");
  expect(summary.stdout).not.toContain("Agent timed out");
  expect(summary.stdout).not.toContain("failed-head");
  expect(summary.stdout.trim().split("\n").length).toBeLessThanOrEqual(
    mascot.trimEnd().split("\n").length + 12,
  );
  const failures = await cli("status", "--failures");
  expect(failures.code).toBe(0);
  expect(failures.stdout).toContain("org/repo#12 / failed");
  expect(failures.stdout).toContain("org/repo#13 / blocked");
  expect(failures.stdout).toContain("Agent timed out");
  expect(failures.stdout).not.toContain("Check agent credentials");
  expect(failures.stdout).not.toContain("org/repo#14");
  expect(failures.stdout).toContain(
    "rprr status https://github.com/org/repo/pull/12",
  );
  const detail = await cli("status", "https://github.com/org/repo/pull/12");
  expect(detail.code).toBe(0);
  expect(detail.stdout).toContain("Check agent credentials before retrying.");
  expect(detail.stdout).toContain("Agent detail");
  expect(detail.stdout).not.toContain("\u001b");
  expect(detail.stdout).toContain(
    "Retry: rprr review https://github.com/org/repo/pull/12",
  );
  expect((await cli("status", "ORG/REPO#13")).stdout).toContain(
    "Automatic retry waits for changed inputs",
  );
  expect((await cli("status", "org/repo#15")).stdout).toContain(
    "Draft: https://github.com/org/repo/pull/15#pullrequestreview-54",
  );
  expect((await cli("status", "org/repo#999")).stderr).toContain(
    "No locally tracked review",
  );
  expect((await cli("status", "not-a-pr")).code).toBe(1);
});

test("a failed poll can be investigated even without any PR jobs", async () => {
  const { env, cli } = await fixture();
  const store = await ReviewStore.open(
    join(env.XDG_STATE_HOME, "rprr", "reviews.sqlite"),
  );
  try {
    store.failPoll(
      store.startPoll(),
      "GitHub request search failed\nAuthentication expired",
    );
  } finally {
    store.close();
  }
  const summary = await cli("status");
  expect(summary.stdout).toContain("rprr status --failures");
  expect(summary.stdout).not.toContain("Authentication expired");
  const failures = await cli("status", "--failures");
  expect(failures.stdout).toContain("Authentication expired");
  expect(failures.stdout).toContain("rprr doctor");
  expect(failures.stdout).toContain("No failed PRs");
});

test("drafts and status reject unsupported or combined options", async () => {
  const { cli } = await fixture();
  for (const args of [
    ["drafts", "--unknown"],
    ["drafts", "--json", "extra"],
    ["status", "--unknown"],
    ["status", "--json", "--failures"],
  ]) {
    const result = await cli(...args);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("accepts");
  }
});

test("healthy status distinguishes ready and actively reviewing", async () => {
  const { env, cli } = await fixture();
  expect(
    (
      await cli(
        "setup",
        "--agent-command",
        process.execPath,
        "--skip-agent-probe",
      )
    ).code,
  ).toBe(0);
  const ready = await cli("status");
  expect(ready.code).toBe(0);
  expect(ready.stdout).toContain("RPRR / Ready");
  expect(ready.stdout).not.toContain("Health: rprr doctor");
  const store = await ReviewStore.open(
    join(env.XDG_STATE_HOME, "rprr", "reviews.sqlite"),
  );
  try {
    store.claim("org/repo", 12, "head", "ryan", 30);
    store.startPoll();
  } finally {
    store.close();
  }
  const reviewing = await cli("status");
  expect(reviewing.stdout).toContain("RPRR / Reviewing");
  expect(reviewing.stdout).toContain("1 reviewing");
  expect(reviewing.stdout).toContain("(running)");
});
