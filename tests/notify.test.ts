import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const program = `import { notifyDraft } from ${JSON.stringify(join(import.meta.dir, "../src/notify.ts"))}; await notifyDraft({ repository: "org/repo", number: 12 }, { url: "https://github.com/org/repo/pull/12#pullrequestreview-1" });`;
const mascot = join(import.meta.dir, "../assets/mascot-v3.png");

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "rprr-notify-test-"));
  const executable = join(directory, "notify-send");
  const log = join(directory, "args");
  await writeFile(
    executable,
    '#!/bin/sh\nprintf \'%s\\0\' "$@" > "$RPRR_NOTIFY_TEST_LOG"\n',
  );
  await chmod(executable, 0o755);
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH ?? ""}`,
    XDG_CURRENT_DESKTOP: "GNOME",
    XDG_CACHE_HOME: join(directory, "cache"),
    RPRR_NOTIFY_TEST_LOG: log,
  };
  async function run(
    command = [process.execPath, "-e", program],
    overrides = {},
  ) {
    const child = Bun.spawn(command, {
      cwd: directory,
      env: { ...env, ...overrides },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stdout, stderr }).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
  }
  return {
    directory,
    executable,
    env,
    run,
    args: async () => (await readFile(log, "utf8")).split("\0").filter(Boolean),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function assertMascot(args: string[]): Promise<string> {
  const icon = args.find((arg) => arg.startsWith("--icon="))?.slice(7);
  expect(icon).toBeDefined();
  if (!icon) throw new Error("Expected mascot icon");
  // Read after the sender exits, as a notification daemon or its history would.
  expect(await readFile(icon)).toEqual(await readFile(mascot));
  expect(args).toContain("--app-name=RPRR");
  expect(args).toContain("--urgency=critical");
  expect(args).toContain("--expire-time=0");
  expect(args).toContain("--hint=boolean:resident:true");
  expect(args).not.toContain("--wait");
  expect(args).toContain("Draft review ready");
  expect(args).toContain(
    "org/repo#12\nhttps://github.com/org/repo/pull/12#pullrequestreview-1",
  );
  return icon;
}

test("draft toast retains its mascot and requests no expiry from any working directory", async () => {
  const f = await fixture();
  try {
    await f.run();
    const args = await f.args();
    const icon = await assertMascot(args);
    expect(icon.startsWith(f.env.XDG_CACHE_HOME)).toBe(true);
    expect(
      args.some((arg) => arg.startsWith("--hint=string:image-path:")),
    ).toBe(false);
    await f.run();
    expect(await assertMascot(await f.args())).toBe(icon);
    expect(
      await readdir(join(f.env.XDG_CACHE_HOME, "rprr", "notifications")),
    ).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("Cinnamon supplies the real mascot through both image entry points", async () => {
  const f = await fixture();
  try {
    await f.run(undefined, { XDG_CURRENT_DESKTOP: "x-cinnamon:GNOME" });
    const args = await f.args();
    const icon = await assertMascot(args);
    expect(args).toContain(`--hint=string:image-path:${icon}`);
  } finally {
    await f.cleanup();
  }
});

test("compiled toast keeps its embedded mascot available after exit", async () => {
  const f = await fixture();
  try {
    const entrypoint = join(f.directory, "entry.ts");
    const binary = join(f.directory, "rprr-notify-test");
    await writeFile(entrypoint, program);
    const build = Bun.spawn(
      [process.execPath, "build", "--compile", entrypoint, "--outfile", binary],
      { stdout: "pipe", stderr: "pipe" },
    );
    const buildError = await new Response(build.stderr).text();
    expect(await build.exited, buildError).toBe(0);
    await f.run([binary]);
    const icon = await assertMascot(await f.args());
    await f.run([binary], { XDG_CURRENT_DESKTOP: "X-Cinnamon" });
    expect(await assertMascot(await f.args())).toBe(icon);
    expect(await f.args()).toContain(`--hint=string:image-path:${icon}`);
  } finally {
    await f.cleanup();
  }
});

test("unwritable asset cache still allows a text notification", async () => {
  const f = await fixture();
  try {
    await writeFile(f.env.XDG_CACHE_HOME, "not a directory");
    await f.run();
    const args = await f.args();
    expect(args).toContain("Draft review ready");
    expect(args.some((arg) => arg.startsWith("--icon="))).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("missing or failing notify-send stays optional", async () => {
  const f = await fixture();
  try {
    await f.run(undefined, { PATH: "" });
    await expect(f.args()).rejects.toThrow();
    await writeFile(f.executable, "#!/bin/sh\nexit 1\n");
    await f.run();
  } finally {
    await f.cleanup();
  }
});
