import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { appPaths, type Config, createConfig, loadConfig } from "./config.ts";
import { currentLogin, requestedPullRequests } from "./github.ts";
import { pollRequested } from "./poll.ts";
import { reviewPullRequest } from "./review.ts";
import { initializeState, ReviewStore } from "./state.ts";

const help = `rprr — Ryan's PR Reviewer

Usage:
  rprr init [--agent-command EXECUTABLE] [--agent-arg ARG ...]
  rprr doctor
  rprr review <PR-number-or-URL> [--publish]
  rprr poll
  rprr status
  rprr --help

Review prints a dry run by default. --publish submits a COMMENT review.
Poll reviews direct requests once and exits; run it from a local scheduler.`;

function commandAvailable(command: string): boolean {
  return Bun.which(command) !== null;
}

function githubAuthenticated(): boolean {
  if (!commandAvailable("gh")) return false;
  return (
    Bun.spawnSync(["gh", "auth", "status"], {
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode === 0
  );
}

function initOptions(args: string[]): {
  command?: string;
  agentArgs: string[];
} {
  const options: { command?: string; agentArgs: string[] } = { agentArgs: [] };
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token !== "--agent-command" && token !== "--agent-arg") {
      throw new Error(`Unknown init option: ${token}`);
    }
    const value = args[++index];
    if (value === undefined) throw new Error(`${token} requires a value`);
    if (token === "--agent-command") options.command = value;
    else options.agentArgs.push(value);
  }
  return options;
}

async function init(args: string[]): Promise<void> {
  if (!githubAuthenticated())
    throw new Error(
      "GitHub CLI is not authenticated. Run `gh auth login` first.",
    );
  const options = initOptions(args);
  let command = options.command;
  if (!command) {
    if (!process.stdin.isTTY)
      throw new Error("Pass --agent-command when running without a terminal.");
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      command = (await prompt.question("ACP agent executable: ")).trim();
    } finally {
      prompt.close();
    }
  }
  if (!command) throw new Error("An ACP agent executable is required.");
  if (!commandAvailable(command))
    throw new Error(`Agent executable not found: ${command}`);
  const config: Config = {
    agent: { command, args: options.agentArgs },
    github: { trigger: "review-request" },
    review: { publish: true, timeoutSeconds: 900, maxFindings: 20 },
  };
  const paths = appPaths();
  await createConfig(config, paths.config);
  await initializeState(paths.state);
  await mkdir(paths.cache, { recursive: true, mode: 0o700 });
  console.log(`Created ${paths.config}`);
  console.log(`Initialized ${paths.state}`);
}

async function doctor(): Promise<void> {
  const checks: Array<[string, boolean, string, string]> = [
    ["Bun", true, Bun.version, "install Bun"],
    ["Git", commandAvailable("git"), "available", "install Git"],
    ["GitHub CLI", commandAvailable("gh"), "available", "install gh"],
    [
      "GitHub authentication",
      githubAuthenticated(),
      "authenticated",
      "run gh auth login",
    ],
  ];
  const paths = appPaths();
  try {
    const config = await loadConfig(paths.config);
    checks.push(["Configuration", true, paths.config, "run rprr init"]);
    checks.push([
      "ACP agent executable",
      commandAvailable(config.agent.command),
      config.agent.command,
      `not found: ${config.agent.command}`,
    ]);
  } catch (error) {
    checks.push([
      "Configuration",
      false,
      "",
      error instanceof Error ? error.message : String(error),
    ]);
  }
  for (const [label, pass, success, failure] of checks) {
    console.log(`${pass ? "✓" : "✗"} ${label}: ${pass ? success : failure}`);
  }
  checks.push([
    "Read-only sandbox",
    process.platform === "linux" && commandAvailable("bwrap"),
    "bubblewrap available",
    "install bubblewrap on Linux",
  ]);
  if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
}

async function poll(): Promise<void> {
  const config = await loadConfig();
  if (!config.review.publish)
    throw new Error("Polling requires review.publish: true in configuration");
  const store = await ReviewStore.open();
  try {
    const result = await pollRequested(
      await requestedPullRequests(),
      await currentLogin(),
      config,
      store,
    );
    console.log(JSON.stringify(result, null, 2));
    if (result.failed.length) process.exitCode = 1;
  } finally {
    store.close();
  }
}

async function status(): Promise<void> {
  const store = await ReviewStore.open();
  try {
    console.log(JSON.stringify(store.recent(), null, 2));
  } finally {
    store.close();
  }
}

export async function runCli(args: string[]): Promise<void> {
  try {
    const [command, ...rest] = args;
    switch (command) {
      case "init":
        await init(rest);
        break;
      case "doctor":
        if (rest.length) throw new Error("doctor does not accept arguments");
        await doctor();
        break;
      case "review": {
        const publish = rest.includes("--publish");
        const selectors = rest.filter((value) => value !== "--publish");
        const selector = selectors[0];
        if (!selector || selectors.length !== 1 || rest.length > 2)
          throw new Error(
            "review requires one PR number or URL and optional --publish",
          );
        const config = await loadConfig();
        const result = await reviewPullRequest(selector, config, publish);
        console.log(JSON.stringify({ ...result, dryRun: !publish }, null, 2));
        break;
      }
      case "poll":
        if (rest.length) throw new Error("poll does not accept arguments");
        await poll();
        break;
      case "status":
        if (rest.length) throw new Error("status does not accept arguments");
        await status();
        break;
      case undefined:
      case "--help":
      case "-h":
        console.log(help);
        break;
      default:
        throw new Error(`Unknown command: ${command}\n\n${help}`);
    }
  } catch (error) {
    console.error(
      `rprr: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
