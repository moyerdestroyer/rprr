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
import { composeReviewPrompt } from "../src/prompt.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("composed prompt keeps the response contract", () => {
  const prompt = composeReviewPrompt("Look carefully.", '{"url":"x"}');
  expect(prompt).toContain("Look carefully.");
  expect(prompt).toContain("untrusted data");
  expect(prompt).toContain('{"url":"x"}');
});

test("prompt edit overrides the built-in instructions and setup keeps it", async () => {
  const home = await mkdtemp(join(tmpdir(), "rprr-prompt-"));
  temporary.push(home);
  const bin = join(home, "bin");
  await mkdir(bin);
  const editor = join(bin, "editor");
  await writeFile(
    editor,
    "#!/bin/sh\nprintf '%s\\n' 'Look for race conditions.' > \"$1\"\n",
  );
  await chmod(editor, 0o755);
  const gh = join(bin, "gh");
  await writeFile(gh, '#!/bin/sh\n[ "$1" = auth ] && exit 0\nexit 1\n');
  await chmod(gh, 0o755);
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    PATH: `${bin}:${process.env.PATH}`,
    VISUAL: editor,
  };
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
  const config = join(env.XDG_CONFIG_HOME, "rprr", "config.json");
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
  const shown = await cli("prompt", "show");
  expect(shown.code).toBe(0);
  expect(shown.stdout).toContain("Source: built-in");
  expect(shown.stdout).toContain("Pull request review");
  expect((await cli("prompt", "edit")).code).toBe(0);
  const edited = JSON.parse(await readFile(config, "utf8"));
  const promptFile = join(env.XDG_CONFIG_HOME, "rprr", "prompt.md");
  expect(edited.review.promptFile).toBe(promptFile);
  expect(await readFile(promptFile, "utf8")).toContain("race conditions");
  expect((await cli("prompt", "show")).stdout).toContain(promptFile);
  expect(
    (await cli("config", "set", "review.skill", "security-review")).code,
  ).toBe(0);
  expect((await cli("setup", "--skip-agent-probe")).code).toBe(0);
  const kept = JSON.parse(await readFile(config, "utf8"));
  expect(kept.review.promptFile).toBe(promptFile);
  expect(kept.review.skill).toBe("security-review");
  expect((await cli("config", "set", "review.skill", "bad name")).code).toBe(1);
  expect(
    (await cli("config", "set", "review.promptFile", "relative.md")).code,
  ).toBe(1);
  expect((await cli("prompt", "reset")).code).toBe(0);
  const reset = JSON.parse(await readFile(config, "utf8"));
  expect(reset.review.promptFile).toBeUndefined();
  expect(reset.review.skill).toBe("security-review");
  await expect(readFile(promptFile)).rejects.toThrow();
  expect((await cli("config", "set", "review.skill", "")).code).toBe(0);
  expect(
    JSON.parse(await readFile(config, "utf8")).review.skill,
  ).toBeUndefined();
});

test("prompt override rejects missing files and keeps a custom path", async () => {
  const home = await mkdtemp(join(tmpdir(), "rprr-prompt-"));
  temporary.push(home);
  const configDir = join(home, ".config", "rprr");
  await mkdir(configDir, { recursive: true });
  const config = join(configDir, "config.json");
  const custom = join(home, "custom.md");
  await writeFile(
    config,
    `${JSON.stringify({
      schemaVersion: 1,
      agent: { command: "acp-reviewer", args: [] },
      github: { trigger: "review-request" },
      review: { publish: false, timeoutSeconds: 900, maxFindings: 20 },
    })}\n`,
  );
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    VISUAL: "",
    EDITOR: "",
  };
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
  const missingEditor = await cli("prompt", "edit");
  expect(missingEditor.code).toBe(1);
  expect(missingEditor.stderr).toContain("VISUAL or EDITOR");
  await expect(readFile(join(configDir, "prompt.md"))).rejects.toThrow();
  const reset = await cli("prompt", "reset");
  expect(reset.code).toBe(0);
  expect(reset.stdout).toContain("Using the built-in review prompt");
  const missing = await cli(
    "config",
    "set",
    "review.promptFile",
    join(home, "missing.md"),
  );
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("not found");
  await writeFile(custom, " \n");
  expect((await cli("config", "set", "review.promptFile", custom)).code).toBe(
    1,
  );
  await writeFile(custom, "Look at migrations.\n");
  expect((await cli("config", "set", "review.promptFile", custom)).code).toBe(
    0,
  );
  expect((await cli("prompt", "show")).stdout).toContain(custom);
  const editor = join(home, "editor");
  await writeFile(
    editor,
    "#!/bin/sh\nprintf '%s\\n' 'Edited custom.' > \"$1\"\n",
  );
  await chmod(editor, 0o755);
  env.VISUAL = editor;
  expect((await cli("prompt", "edit")).code).toBe(0);
  expect(await readFile(custom, "utf8")).toContain("Edited custom.");
  await expect(readFile(join(configDir, "prompt.md"))).rejects.toThrow();
  expect((await cli("prompt", "reset")).code).toBe(0);
  expect(JSON.parse(await readFile(config, "utf8")).review.promptFile).toBe(
    undefined,
  );
  expect(await readFile(custom, "utf8")).toContain("Edited custom.");
  expect((await cli("prompt", "nope")).code).toBe(1);
});
