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
    "package/prompts/review.md",
    "package/assets/mascot-v3.png",
    "package/assets/mascot-banner-v2.png",
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
  await run(
    [
      "bun",
      "scripts/build-release.ts",
      "--host",
      "--out",
      join(temporary, "dist"),
    ],
    root,
  );
  const hostBinary = join(
    temporary,
    "dist",
    process.arch === "arm64" ? "rprr-linux-arm64" : "rprr-linux-x64",
  );
  const serviceTools = join(temporary, "service-tools");
  await mkdir(serviceTools);
  for (const name of ["gh", "systemctl", "systemd-analyze"]) {
    const executable = join(serviceTools, name);
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
  }
  const configDir = join(env.XDG_CONFIG_HOME, "rprr");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      schemaVersion: 1,
      agent: { command: "/bin/true", args: [] },
      github: { trigger: "review-request" },
      review: { timeoutSeconds: 900, maxFindings: 20 },
    }),
  );
  await run([hostBinary, "service", "install"], temporary, {
    ...env,
    PATH: `${serviceTools}:${process.env.PATH ?? ""}`,
  });
  const unit = await readFile(
    join(env.XDG_CONFIG_HOME, "systemd", "user", "rprr.service"),
    "utf8",
  );
  if (!unit.includes(`ExecStart=${JSON.stringify(hostBinary)} "poll"`))
    throw new Error("Compiled CLI service does not run its own binary");
  console.log(
    `Packed ${entries.length} files and started the CLI from an isolated global installation`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
