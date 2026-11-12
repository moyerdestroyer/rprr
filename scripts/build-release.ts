import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const targets = [
  ["bun-linux-x64", "rprr-linux-x64"],
  ["bun-linux-arm64", "rprr-linux-arm64"],
] as const;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

function hostAsset(): string {
  if (process.platform !== "linux")
    throw new Error("Release binaries are built on Linux");
  if (process.arch === "x64") return "rprr-linux-x64";
  if (process.arch === "arm64") return "rprr-linux-arm64";
  throw new Error(`Unsupported architecture: ${process.arch}`);
}

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, {
    cwd,
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

const version = (
  JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    version: string;
  }
).version;
const out = argument("--out") ?? join(root, "dist");
const selected = process.argv.includes("--host")
  ? targets.filter(([, name]) => name === hostAsset())
  : targets;
await mkdir(out, { recursive: true });

const sums: string[] = [];
for (const [target, name] of selected) {
  const outfile = join(out, name);
  await run(
    [
      "bun",
      "build",
      "--compile",
      `--target=${target}`,
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "bin/rprr.ts",
      "--outfile",
      outfile,
    ],
    root,
  );
  const hash = createHash("sha256")
    .update(await readFile(outfile))
    .digest("hex");
  sums.push(`${hash}  ${name}`);
}

await writeFile(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
await writeFile(join(out, "VERSION"), `v${version}\n`);

const host = join(out, hostAsset());
const embedded = await readFile(host);
if (!embedded.includes(Buffer.from("Return only a JSON object")))
  throw new Error("Review prompt was not embedded in the release binary");
if (!embedded.includes(Buffer.from("mascot-v3.png")))
  throw new Error("Notification icon was not embedded in the release binary");
const started = await run([host, "--version"], out);
if (started !== version)
  throw new Error(`Binary version ${started} does not match ${version}`);
const help = await run([host, "--help"], out);
if (!help.includes("rprr service install"))
  throw new Error("Release binary did not start");
console.log(`Built ${selected.map(([, name]) => name).join(", ")}`);
