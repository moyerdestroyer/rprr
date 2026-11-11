import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function run(
  command: string[],
  cwd: string,
  env = process.env,
): Promise<string> {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(
      `${command.join(" ")} failed: ${stderr.trim() || stdout.trim()}`,
    );
  return stdout.trim();
}

const root = join(import.meta.dir, "..");
const temporary = await mkdtemp(join(tmpdir(), "rprr-package-check-"));
try {
  const archive = (
    await run(
      ["bun", "pm", "pack", "--destination", temporary, "--quiet"],
      root,
    )
  )
    .split("\n")
    .at(-1);
  if (!archive) throw new Error("Bun did not create a package archive");
  const archivePath = archive.startsWith("/")
    ? archive
    : join(temporary, archive);
  const entries = (await run(["tar", "-tzf", archivePath], temporary)).split(
    "\n",
  );
  for (const expected of [
    "package/bin/rprr.ts",
    "package/src/cli.ts",
    "package/docs/scheduling.md",
    "package/examples/systemd/rprr.service",
    "package/examples/systemd/rprr.timer",
    "package/assets/mascot-v3.png",
  ]) {
    if (!entries.includes(expected))
      throw new Error(`Package is missing ${expected}`);
  }
  await run(["tar", "-xzf", archivePath], temporary);
  const packagePath = join(temporary, "package");
  const home = join(temporary, "home");
  await mkdir(home);
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    BUN_INSTALL: join(temporary, "bun"),
  };
  await run(["bun", "install", "--production"], packagePath, env);
  const help = await run(["bun", "bin/rprr.ts", "--help"], packagePath, env);
  if (!help.includes("rprr service install"))
    throw new Error("Packed CLI did not start");
  await run(["bun", "add", "--global", archivePath], temporary, env);
  const installed = join(env.BUN_INSTALL, "bin", "rprr");
  const installedHelp = await run([installed, "--help"], temporary, {
    ...env,
    PATH: `${join(env.BUN_INSTALL, "bin")}:${process.env.PATH}`,
  });
  if (!installedHelp.includes("rprr service install"))
    throw new Error("Globally installed CLI did not start");
  console.log(
    `Packed ${entries.length} files and started the CLI from an isolated global installation`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
