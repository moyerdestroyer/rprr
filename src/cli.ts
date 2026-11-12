import { appPaths, loadConfig } from "./config.ts";
import { configCommand } from "./config-command.ts";
import { currentLogin, requestedPullRequests } from "./github.ts";
import {
  advertisedSkills,
  commandAvailable,
  githubAuthenticated,
  healthSnapshot,
  probeAgent,
} from "./health.ts";
import { pollRequested } from "./poll.ts";
import { promptCommand } from "./prompt.ts";
import { reviewPullRequest } from "./review.ts";
import {
  disableService,
  enableService,
  installService,
  serviceStatus,
  uninstallService,
} from "./service.ts";
import { setup } from "./setup.ts";
import { ReviewStore } from "./state.ts";
import { version } from "./version.ts";

const help = `rprr — Ryan's PR Reviewer

Usage:
  rprr setup [--agent-command EXECUTABLE] [--agent-arg ARG ...] [--publish] [--dry-run] [--skip-agent-probe]
  rprr init [setup options]
  rprr doctor [--deep]
  rprr config show|validate|set|edit
  rprr prompt show|edit|reset
  rprr skills
  rprr review <PR-number-or-URL> [--publish]
  rprr poll
  rprr status
  rprr service install|enable|disable|status|uninstall
  rprr --help
  rprr --version

Review prints a dry run by default. --publish submits a COMMENT review.
Poll reviews direct requests once and exits; run it from a local scheduler.
In a terminal, setup asks for the agent and whether to publish or schedule.
prompt edit replaces the built-in review instructions.
skills lists slash commands advertised by the configured agent.`;

async function doctor(deep: boolean): Promise<void> {
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
    checks.push(["Configuration", true, paths.config, "run rprr setup"]);
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
  checks.push([
    "Read-only sandbox",
    process.platform === "linux" && commandAvailable("bwrap"),
    "bubblewrap available",
    "install bubblewrap on Linux",
  ]);
  if (deep) checks.push(await handshakeCheck(paths.config));
  for (const [label, pass, success, failure] of checks) {
    console.log(`${pass ? "✓" : "✗"} ${label}: ${pass ? success : failure}`);
  }
  if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
}

async function handshakeCheck(
  path: string,
): Promise<[string, boolean, string, string]> {
  try {
    await probeAgent(await loadConfig(path));
    return ["ACP handshake", true, "review response validated", ""];
  } catch (error) {
    return [
      "ACP handshake",
      false,
      "",
      error instanceof Error ? error.message : String(error),
    ];
  }
}

async function poll(): Promise<void> {
  const config = await loadConfig();
  if (!config.review.publish)
    throw new Error("Polling requires review.publish: true in configuration");
  const store = await ReviewStore.open();
  const runId = store.startPoll();
  try {
    const result = await pollRequested(
      await requestedPullRequests(),
      await currentLogin(),
      config,
      store,
    );
    console.log(JSON.stringify(result, null, 2));
    store.finishPoll(runId, { ...result, failed: result.failed.length });
    if (result.failed.length) process.exitCode = 1;
  } catch (error) {
    store.failPoll(
      runId,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  } finally {
    store.close();
  }
}

async function status(): Promise<void> {
  const store = await ReviewStore.open();
  try {
    console.log(
      JSON.stringify(
        {
          lastPoll: store.latestPoll(),
          jobs: store.recent(),
          health: await healthSnapshot(),
          service: await serviceStatus(),
        },
        null,
        2,
      ),
    );
  } finally {
    store.close();
  }
}

async function service(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (rest.length) throw new Error("service accepts exactly one action");
  switch (action) {
    case "install":
      console.log(
        JSON.stringify(await installService(await loadConfig()), null, 2),
      );
      console.log(
        "Timer installed but disabled. Run `rprr service enable` to start polling.",
      );
      break;
    case "enable":
      if (!(await loadConfig()).review.publish)
        throw new Error("Enable publication with `rprr setup --publish` first");
      await enableService();
      console.log("RPRR timer enabled");
      break;
    case "disable":
      await disableService();
      console.log("RPRR timer disabled");
      break;
    case "status":
      console.log(JSON.stringify(await serviceStatus(), null, 2));
      break;
    case "uninstall":
      await uninstallService();
      console.log("RPRR timer removed");
      break;
    default:
      throw new Error(
        "service requires install, enable, disable, status, or uninstall",
      );
  }
}

function showVersion(rest: string[]): void {
  if (rest.length) throw new Error("--version does not accept arguments");
  console.log(version);
}

async function skills(rest: string[]): Promise<void> {
  if (rest.length) throw new Error("skills does not accept arguments");
  const commands = await advertisedSkills(await loadConfig());
  if (!commands.length) {
    console.log("The agent advertised no slash commands.");
    return;
  }
  for (const command of commands)
    console.log(
      command.description
        ? `/${command.name}  ${command.description}`
        : `/${command.name}`,
    );
}

async function review(rest: string[]): Promise<void> {
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
}

export async function runCli(args: string[]): Promise<void> {
  try {
    const [command, ...rest] = args;
    switch (command) {
      case "setup":
      case "init":
        await setup(rest);
        break;
      case "doctor":
        if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--deep"))
          throw new Error("doctor accepts only --deep");
        await doctor(rest[0] === "--deep");
        break;
      case "config":
        await configCommand(rest);
        break;
      case "prompt":
        await promptCommand(rest);
        break;
      case "skills":
        await skills(rest);
        break;
      case "review":
        await review(rest);
        break;
      case "poll":
        if (rest.length) throw new Error("poll does not accept arguments");
        await poll();
        break;
      case "status":
        if (rest.length) throw new Error("status does not accept arguments");
        await status();
        break;
      case "service":
        await service(rest);
        break;
      case undefined:
      case "--help":
      case "-h":
        console.log(help);
        break;
      case "--version":
      case "-V":
        showVersion(rest);
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
