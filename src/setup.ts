import { mkdir } from "node:fs/promises";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { configuredAgentCommand } from "./agent-command.ts";
import { type DetectedAgent, discoverAgents } from "./agent-discovery.ts";
import { appPaths, type Config, loadConfig, saveConfig } from "./config.ts";
import { commandAvailable, githubAuthenticated, probeAgent } from "./health.ts";
import { enableService, installService } from "./service.ts";
import { initializeState } from "./state.ts";

type SetupChoices = {
  command: string;
  args: string[];
  enableTimer: boolean;
};

type Options = {
  command?: string;
  args: string[];
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
      timeoutSeconds: current?.review.timeoutSeconds ?? 900,
      maxFindings: current?.review.maxFindings ?? 20,
      ...(current?.review.promptFile
        ? { promptFile: current.review.promptFile }
        : {}),
      ...(current?.review.skill ? { skill: current.review.skill } : {}),
    },
  };
}

function checkDependencies(): void {
  for (const executable of ["git", "gh"]) {
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
  const command = (await ask("ACP agent executable or path: ")).trim();
  if (!command) throw new Error("An ACP agent executable is required");
  const input = await ask(
    "ACP arguments, separated by spaces (blank to auto-detect): ",
  );
  return {
    command,
    args: splitAgentArgs(input),
  };
}

export async function interviewSetup(
  ask: (prompt: string) => Promise<string>,
  available: {
    timer: boolean;
    agents?: readonly DetectedAgent[];
    current?: { command: string; args: string[] };
  },
): Promise<SetupChoices> {
  const agent = await selectAgent(
    ask,
    available.agents ?? [],
    available.current,
  );
  const enableTimer =
    available.timer &&
    decideYesNo(
      await ask("Check for review requests every 15 minutes? [y/N] "),
      false,
    );
  return { ...agent, enableTimer };
}

function sameAgent(
  left: { command: string; args: string[] },
  right: { command: string; args: string[] },
): boolean {
  return (
    left.command === right.command &&
    left.args.length === right.args.length &&
    left.args.every((arg, index) => arg === right.args[index])
  );
}

async function selectAgent(
  ask: (prompt: string) => Promise<string>,
  detected: readonly DetectedAgent[],
  current?: { command: string; args: string[] },
): Promise<{ command: string; args: string[] }> {
  const choices = [
    ...(current
      ? [{ ...current, name: `Current (${basename(current.command)})` }]
      : []),
    ...detected.filter((agent) => !current || !sameAgent(agent, current)),
  ];
  if (choices.length === 0) return customAgent(ask);
  const lines = choices.map((agent, index) =>
    `  ${index + 1}) ${agent.name} — ${basename(agent.command)} ${agent.args.join(" ")}`.trimEnd(),
  );
  const customIndex = choices.length + 1;
  const answer = (
    await ask(
      `Reviewer agents:\n${lines.join("\n")}\n  ${customIndex}) Custom command or path\nSelect reviewer agent [1]: `,
    )
  ).trim();
  const choice = answer === "" ? 1 : Number(answer);
  if (!Number.isInteger(choice) || choice < 1 || choice > customIndex)
    throw new Error("Choose a listed reviewer agent number");
  if (choice === customIndex) return customAgent(ask);
  const selected = choices[choice - 1];
  if (!selected) throw new Error("Choose a listed reviewer agent number");
  return { command: selected.command, args: selected.args };
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function promptSetup(
  current: Config | undefined,
  detect: boolean,
): Promise<ResolvedSetup> {
  if (detect) console.log("Detecting installed ACP agents...");
  const agents = detect ? await discoverAgents() : [];
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await interviewSetup((question) => prompt.question(question), {
      agents,
      ...(current ? { current: current.agent } : {}),
      timer:
        !current &&
        process.platform === "linux" &&
        commandAvailable("systemctl") &&
        commandAvailable("systemd-analyze"),
    });
  } finally {
    prompt.close();
  }
}

async function resolveSetup(
  options: Options,
  current?: Config,
): Promise<ResolvedSetup> {
  if (options.command)
    return {
      command: options.command,
      enableTimer: false,
    };
  if (isInteractive())
    return promptSetup(current, !options.skipProbe && !options.dryRun);
  if (current) return { command: current.agent.command, enableTimer: false };
  throw new Error("Pass --agent-command when running without a terminal");
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

async function probeSetupAgent(config: Config): Promise<Config> {
  try {
    await probeAgent(config);
    return config;
  } catch (directError) {
    if (config.agent.args.length > 0) throw directError;
    const withAcp = {
      ...config,
      agent: { ...config.agent, args: ["acp"] },
    };
    try {
      await probeAgent(withAcp);
      return withAcp;
    } catch (acpError) {
      const direct =
        directError instanceof Error
          ? directError.message
          : String(directError);
      const subcommand =
        acpError instanceof Error ? acpError.message : String(acpError);
      throw new Error(
        `Agent did not complete an ACP probe directly or with the \`acp\` subcommand.\nDirect: ${direct}\nWith \`acp\`: ${subcommand}\nEnter this agent's ACP launch arguments during setup or pass --agent-arg.`,
      );
    }
  }
}

export async function setup(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const paths = appPaths();
  const current = await currentConfig(paths.config);
  const selected = await resolveSetup(options, current);
  const resolved = {
    ...selected,
    command: configuredAgentCommand(selected.command),
  };
  const proposed = proposedConfig(options, current, resolved);
  checkDependencies();
  const config =
    options.dryRun || options.skipProbe
      ? proposed
      : await probeSetupAgent(proposed);
  showPreview(
    paths.config,
    config,
    options.dryRun ? "preview" : current ? "update" : "create",
  );
  if (options.dryRun) return;
  const result = await saveConfig(config, paths.config);
  await initializeState(paths.state);
  await mkdir(paths.cache, { recursive: true, mode: 0o700 });
  console.log(`Configuration ${result}: ${paths.config}`);
  console.log(`State ready: ${paths.state}`);
  if (resolved.enableTimer) {
    await startTimer(config);
    return;
  }
  if (current) {
    console.log(
      "Existing timer setting kept. Run `rprr service status` to check it.",
    );
    return;
  }
  console.log(
    "Run `rprr poll` once, or `rprr service enable` to start drafting reviews.",
  );
}
