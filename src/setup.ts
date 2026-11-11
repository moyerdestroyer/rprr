import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { appPaths, type Config, loadConfig, saveConfig } from "./config.ts";
import { commandAvailable, githubAuthenticated, probeAgent } from "./health.ts";
import { initializeState } from "./state.ts";

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

function proposedConfig(
  options: Options,
  current: Config | undefined,
  command: string,
): Config {
  const changedAgent = current?.agent.command !== command;
  return {
    schemaVersion: 1,
    agent: {
      command,
      args:
        options.args.length > 0
          ? options.args
          : changedAgent
            ? []
            : (current?.agent.args ?? []),
      ...(!changedAgent && current?.agent.env
        ? { env: current.agent.env }
        : {}),
    },
    github: { trigger: "review-request" },
    review: {
      publish: options.publish ?? current?.review.publish ?? false,
      timeoutSeconds: current?.review.timeoutSeconds ?? 900,
      maxFindings: current?.review.maxFindings ?? 20,
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

async function agentCommand(
  options: Options,
  current?: Config,
): Promise<string> {
  if (options.command) return options.command;
  if (current) return current.agent.command;
  if (!process.stdin.isTTY)
    throw new Error("Pass --agent-command when running without a terminal");
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const command = (await prompt.question("ACP agent executable: ")).trim();
    if (!command) throw new Error("An ACP agent executable is required");
    return command;
  } finally {
    prompt.close();
  }
}

export async function setup(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const paths = appPaths();
  const current = await currentConfig(paths.config);
  const command = await agentCommand(options, current);
  const config = proposedConfig(options, current, command);
  checkDependencies(command);
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
  if (!config.review.publish)
    console.log(
      "Publication is disabled. Run `rprr setup --publish` when ready.",
    );
}
