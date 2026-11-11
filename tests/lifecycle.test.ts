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
import { renderUnits } from "../src/service.ts";

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
  expect(JSON.parse(await readFile(config, "utf8")).review.publish).toBe(false);
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
  expect((await cli("service", "enable")).code).toBe(1);
  expect((await cli("setup", "--publish", "--skip-agent-probe")).code).toBe(0);
  expect(JSON.parse(await readFile(config, "utf8")).review.publish).toBe(true);
  expect(
    JSON.parse(await readFile(`${config}.bak`, "utf8")).review.publish,
  ).toBe(false);
  expect((await cli("config", "set", "review.maxFindings", "7")).code).toBe(0);
  expect((await cli("config", "edit")).code).toBe(0);
  expect(JSON.parse(await readFile(config, "utf8")).review.maxFindings).toBe(8);
  const withSecret = JSON.parse(await readFile(config, "utf8"));
  withSecret.agent.env = { TOKEN: "secret-sentinel" };
  await writeFile(config, JSON.stringify(withSecret));
  expect((await cli("config", "show")).stdout).not.toContain("secret-sentinel");
  expect((await cli("config", "validate")).code).toBe(0);
  expect((await cli("config", "set", "review.publish", "maybe")).code).toBe(1);
  expect((await cli("service", "enable")).code).toBe(0);
  const status = JSON.parse((await cli("status")).stdout);
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

test("deep doctor validates an ACP agent inside the read-only sandbox", async () => {
  const { cli } = await fixture();
  const agent = fileURLToPath(new URL("./fixtures/agent.ts", import.meta.url));
  const setup = await cli(
    "setup",
    "--agent-command",
    process.execPath,
    "--agent-arg",
    agent,
  );
  expect(setup.code).toBe(0);
  const doctor = await cli("doctor", "--deep");
  expect(doctor.code).toBe(0);
  expect(doctor.stdout).toContain("✓ ACP handshake");
  expect(doctor.stdout).toContain("✓ Read-only sandbox");
});

test("generated unit quotes executable paths and preserves custom agent path", () => {
  const units = renderUnits(
    "/opt/bun/bin/bun",
    "/opt/agent/bin/cmd",
    "/usr/bin/gh",
  );
  expect(units.service).toContain('ExecStart="/opt/bun/bin/bun"');
  expect(units.service).toContain("/opt/agent/bin");
  expect(units.timer).toContain("Persistent=true");
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
