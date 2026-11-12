import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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

const temporary: string[] = [];
const script = join(import.meta.dir, "../scripts/install.sh");

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function release(body: string, checksum = true) {
  const home = await mkdtemp(join(tmpdir(), "rprr-install-"));
  temporary.push(home);
  const releaseDir = join(home, "release");
  const installDir = join(home, "bin");
  const configHome = join(home, "config");
  await mkdir(releaseDir);
  const asset = join(releaseDir, "rprr-linux-x64");
  await writeFile(asset, body);
  await chmod(asset, 0o755);
  const hash = createHash("sha256").update(body).digest("hex");
  const mismatch = "0".repeat(64);
  await writeFile(
    join(releaseDir, "SHA256SUMS"),
    `${checksum ? hash : mismatch}  rprr-linux-x64\n`,
  );
  await writeFile(join(releaseDir, "VERSION"), "v0.1.0\n");
  const log = join(home, "log");
  const env = {
    ...process.env,
    HOME: home,
    PATH: "/usr/bin:/bin",
    SHELL: "/bin/bash",
    XDG_CONFIG_HOME: configHome,
    RPRR_INSTALL_DIR: installDir,
    RPRR_RELEASE_DIR: releaseDir,
    RPRR_INSTALL_OS: "Linux",
    RPRR_INSTALL_ARCH: "x86_64",
    RPRR_INSTALL_LIBC: "glibc",
    RPRR_INSTALL_ASSUME_TTY: "1",
    RPRR_TEST_LOG: log,
    RPRR_STUB_VERSION: "0.1.0",
  };
  async function run() {
    const child = Bun.spawn(["bash", script], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const calls = await readFile(log, "utf8").catch(() => "");
    return { code, stdout, stderr, calls, installDir, configHome, log };
  }
  return { home, releaseDir, asset, run };
}

const stub = `#!/bin/sh
printf '%s\\n' "$*" >> "$RPRR_TEST_LOG"
case "$1" in
  --version) printf '%s\\n' "$RPRR_STUB_VERSION" ;;
  doctor|setup|service) exit 0 ;;
  *) exit 1 ;;
esac
`;

test("install script installs, skips a second run, and replaces an update", async () => {
  const fixture = await release(stub);
  const first = await fixture.run();
  expect(first.code).toBe(0);
  expect(first.stdout).toContain("Installed rprr v0.1.0");
  expect(first.stdout).toContain("Starting setup.");
  expect(first.calls).toContain("setup");
  expect(first.calls.indexOf("setup")).toBeLessThan(
    first.calls.indexOf("doctor"),
  );
  expect(await readFile(join(fixture.home, ".bashrc"), "utf8")).toContain(
    first.installDir,
  );
  expect(await readFile(join(first.installDir, "rprr"), "utf8")).toBe(stub);
  await mkdir(join(first.configHome, "rprr"), { recursive: true });
  await writeFile(join(first.configHome, "rprr/config.json"), "{}\n");
  await writeFile(first.log, "");
  const second = await fixture.run();
  expect(second.code).toBe(0);
  expect(second.stdout).toContain("already installed");
  expect(second.calls).not.toContain("setup");
  expect(
    (await readFile(join(fixture.home, ".bashrc"), "utf8")).match(
      /# rprr installer/g,
    )?.length,
  ).toBe(1);
  const updated = `${stub}\n# updated\n`;
  await writeFile(fixture.asset, updated);
  const hash = createHash("sha256").update(updated).digest("hex");
  await writeFile(
    join(fixture.releaseDir, "SHA256SUMS"),
    `${hash}  rprr-linux-x64\n`,
  );
  await mkdir(join(first.configHome, "systemd/user"), { recursive: true });
  await writeFile(
    join(first.configHome, "systemd/user/rprr.service"),
    "[Service]\n",
  );
  await writeFile(first.log, "");
  const third = await fixture.run();
  expect(third.code).toBe(0);
  expect(third.stdout).toContain("Updated rprr to v0.1.0");
  expect(third.calls).toContain("service install");
  expect(await readFile(join(first.installDir, "rprr"), "utf8")).toBe(updated);
});

test("install script rejects a checksum mismatch and an unsupported system", async () => {
  const mismatch = await release(stub, false);
  const failed = await mismatch.run();
  expect(failed.code).toBe(1);
  expect(failed.stderr).toContain("Checksum mismatch");
  await expect(readFile(join(failed.installDir, "rprr"))).rejects.toThrow();
  const unsupported = await release(stub);
  const result = await Bun.spawn(["bash", script], {
    env: {
      ...process.env,
      HOME: unsupported.home,
      PATH: "/usr/bin:/bin",
      RPRR_INSTALL_DIR: join(unsupported.home, "bin"),
      RPRR_RELEASE_DIR: unsupported.releaseDir,
      RPRR_INSTALL_OS: "Darwin",
      RPRR_INSTALL_ARCH: "arm64",
      RPRR_TEST_LOG: join(unsupported.home, "log"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(result.stderr).text();
  expect(await result.exited).toBe(1);
  expect(stderr).toContain("built for Linux");
});
