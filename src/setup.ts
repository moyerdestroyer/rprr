import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { appPaths, type Config, loadConfig, saveConfig } from "./config.ts";
import { commandAvailable, githubAuthenticated, probeAgent } from "./health.ts";
import { enableService, installService } from "./service.ts";
import { initializeState } from "./state.ts";

const commandCodeArgs = ["--no-session", "--no-auto-update", "acp"];

type SetupChoices = {
  command: string;
  args: string[];
  publish: boolean;
  enableTimer: boolean;
};

type Options = {
  command?: string;
  args: string[];
  publish?: boolean;
  dryRun: boolean;
  skipProbe: boolean;
};

function parseOptions(args: string[]): Options {
  const options: Options = {
    args: [],
    dryRun: false,
    skipProbe: false,
  };
  for (let index = 0; index < args.length; index++) {
    index += applyOption(options, args[index], args[index + 1]);
  }
  return options;
}

function applyOption(
  options: Options,
  token: string | undefined,
  value: string | undefined,
): number {
  switch (token) {
    case "--dry-run":
      options.dryRun = true;
      return 0;
    case "--skip-agent-probe":
      options.skipProbe = true;
      return 0;
    case "--publish":
      options.publish = true;
      return 0;
    case "--no-publish":
      options.publish = false;
      return 0;
    case "--agent-command":
    case "--agent-arg":
      if (!value) throw new Error(`${token} requires a value`);
      if (token === "--agent-command") options.command = value;
      else options.args.push(value);
      return 1;
    default:
      throw new Error(`Unknown setup option: ${token}`);
  }
}

type ResolvedSetup = {
  command: string;
  args?: string[];
  publish?: boolean;
  enableTimer: boolean;
};

function resolveArgs(
  explicit: string[] | undefined,
  options: Options,
  current: Config | undefined,
  changedAgent: boolean,
): string[] {
  if (explicit !== undefined) return explicit;
  if (options.args.length > 0) return options.args;
  if (!changedAgent && current) return current.agent.args;
  return [];
}

function proposedConfig(
  options: Options,
  current: Config | undefined,
  resolved: ResolvedSetup,
): Config {
  const changedAgent = current?.agent.command !== resolved.command;
  return {
    schemaVersion: 1,
    agent: {
      command: resolved.command,
      args: resolveArgs(resolved.args, options, current, changedAgent),
      ...(!changedAgent && current?.agent.env
        ? { env: current.agent.env }
        : {}),
    },
    github: { trigger: "review-request" },
    review: {
      publish: resolved.publish ?? current?.review.publish ?? false,
      timeoutSeconds: current?.review.timeoutSeconds ?? 900,
      maxFindings: current?.review.maxFindings ?? 20,
      ...(current?.review.promptFile
        ? { promptFile: current.review.promptFile }
        : {}),
      ...(current?.review.skill ? { skill: current.review.skill } : {}),
    },
  };
}

function checkDependencies(command: string): void {
  for (const executable of ["git", "gh", "bwrap", command]) {
    if (!commandAvailable(executable))
      throw new Error(`Required executable not found: ${executable}`);
  }
  if (!githubAuthenticated()) throw new Error("Run `gh auth login` first");
}

function showPreview(path: string, config: Config, action: string): void {
  const preview = {
    ...config,
    agent: {
      ...config.agent,
      ...(config.agent.env
        ? {
            env: Object.fromEntries(
              Object.keys(config.agent.env).map((key) => [key, "<redacted>"]),
            ),
          }
        : {}),
    },
  };
  console.log(
    JSON.stringify({ configPath: path, config: preview, action }, null, 2),
  );
}

async function currentConfig(path: string): Promise<Config | undefined> {
  try {
    return await loadConfig(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}

function decideYesNo(value: string, fallback: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return fallback;
  if (normalized === "y" || normalized === "yes") return true;
  if (normalized === "n" || normalized === "no") return false;
  throw new Error("Answer yes or no");
}

function splitAgentArgs(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/);
}

async function customAgent(
  ask: (prompt: string) => Promise<string>,
): Promise<{ command: string; args: string[] }> {
  const command = (await ask("ACP agent executable: ")).trim();
  if (!command) throw new Error("An ACP agent executable is required");
  return {
    command,
    args: splitAgentArgs(
      await ask("Agent arguments, separated by spaces (blank for none): "),
    ),
  };
}

async function chosenAgent(
  ask: (prompt: string) => Promise<string>,
  commandCode: boolean,
): Promise<{ command: string; args: string[] }> {
  if (!commandCode) return customAgent(ask);
  const usePreset = decideYesNo(
    await ask("Use cmd with --no-session --no-auto-update acp? [Y/n] "),
    true,
  );
  if (usePreset) return { command: "cmd", args: commandCodeArgs };
  return customAgent(ask);
}

export async function interviewSetup(
  ask: (prompt: string) => Promise<string>,
  available: { commandCode: boolean; timer: boolean; publish?: boolean },
): Promise<SetupChoices> {
  const agent = await chosenAgent(ask, available.commandCode);
  const publish =
    available.publish ??
    decideYesNo(
      await ask("Post COMMENT reviews for direct review requests? [y/N] "),
      false,
    );
  const enableTimer =
    publish &&
    available.timer &&
    decideYesNo(
      await ask("Check for review requests every 15 minutes? [y/N] "),
      false,
    );
  return { ...agent, publish, enableTimer };
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function promptSetup(publish?: boolean): Promise<ResolvedSetup> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await interviewSetup((question) => prompt.question(question), {
      commandCode: commandAvailable("cmd"),
      timer:
        process.platform === "linux" &&
        commandAvailable("systemctl") &&
        commandAvailable("systemd-analyze"),
      publish,
    });
  } finally {
    prompt.close();
  }
}

async function resolveSetup(
  options: Options,
  current?: Config,
): Promise<ResolvedSetup> {
  if (options.command || current)
    return {
      command: options.command ?? current?.agent.command ?? "",
      publish: options.publish,
      enableTimer: false,
    };
  if (!isInteractive())
    throw new Error("Pass --agent-command when running without a terminal");
  return promptSetup(options.publish);
}

async function startTimer(config: Config): Promise<void> {
  try {
    await installService(config);
    await enableService();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}. Configuration was saved. Retry with \`rprr service install\` and \`rprr service enable\`.`,
    );
  }
  console.log("Timer enabled. It checks every 15 minutes.");
}

export async function setup(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const paths = appPaths();
  const current = await currentConfig(paths.config);
  const resolved = await resolveSetup(options, current);
  const config = proposedConfig(options, current, resolved);
  checkDependencies(resolved.command);
  showPreview(
    paths.config,
    config,
    options.dryRun ? "preview" : current ? "update" : "create",
  );
  if (options.dryRun) return;
  if (!options.skipProbe) await probeAgent(config);
  const result = await saveConfig(config, paths.config);
  await initializeState(paths.state);
  await mkdir(paths.cache, { recursive: true, mode: 0o700 });
  console.log(`Configuration ${result}: ${paths.config}`);
  console.log(`State ready: ${paths.state}`);
  if (resolved.enableTimer) {
    await startTimer(config);
    return;
  }
  if (!config.review.publish)
    console.log(
      "Publication is disabled. Run `rprr setup --publish` when ready.",
    );
  else
    console.log(
      "Run `rprr poll` once, or `rprr service enable` to start the timer.",
    );
}
