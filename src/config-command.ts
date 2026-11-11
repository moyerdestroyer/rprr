import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import {
  appPaths,
  type Config,
  loadConfig,
  saveConfig,
  validateConfig,
} from "./config.ts";

function redacted(config: Config): Config {
  if (!config.agent.env) return config;
  return {
    ...config,
    agent: {
      ...config.agent,
      env: Object.fromEntries(
        Object.keys(config.agent.env).map((key) => [key, "<redacted>"]),
      ),
    },
  };
}

function valueFor(key: string, raw: string): unknown {
  if (key === "review.publish") {
    if (raw !== "true" && raw !== "false")
      throw new Error("review.publish must be true or false");
    return raw === "true";
  }
  if (key === "review.timeoutSeconds" || key === "review.maxFindings") {
    if (!/^[1-9]\d*$/.test(raw))
      throw new Error(`${key} must be a positive integer`);
    return Number(raw);
  }
  if (key === "agent.args") return JSON.parse(raw);
  if (key === "agent.command") return raw;
  throw new Error(`Unsupported config key: ${key}`);
}

function changed(config: Config, key: string, raw: string): Config {
  const value = valueFor(key, raw);
  const [section, field] = key.split(".");
  if (section === "agent")
    return validateConfig({
      ...config,
      agent: { ...config.agent, [field ?? ""]: value },
    });
  return validateConfig({
    ...config,
    review: { ...config.review, [field ?? ""]: value },
  });
}

async function editConfig(config: Config, path: string): Promise<void> {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor || !Bun.which(editor))
    throw new Error(
      "Set VISUAL or EDITOR to an editor executable before using config edit",
    );
  const temporary = `${path}.${crypto.randomUUID()}.edit`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    const child = Bun.spawn([editor, temporary], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await child.exited) !== 0)
      throw new Error("Editor exited without saving configuration");
    await chmod(temporary, 0o600);
    const edited = validateConfig(
      JSON.parse(await readFile(temporary, "utf8")),
    );
    console.log(`Configuration ${await saveConfig(edited, path)}: ${path}`);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function configCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  const path = appPaths().config;
  const config = await loadConfig(path);
  switch (action) {
    case "show":
      if (rest.length) throw new Error("config show accepts no arguments");
      console.log(JSON.stringify(redacted(config), null, 2));
      break;
    case "validate":
      if (rest.length) throw new Error("config validate accepts no arguments");
      console.log(`Valid configuration: ${path}`);
      break;
    case "set":
      if (rest.length !== 2 || !rest[0] || rest[1] === undefined)
        throw new Error("config set requires a key and value");
      console.log(
        `Configuration ${await saveConfig(changed(config, rest[0], rest[1]), path)}: ${path}`,
      );
      break;
    case "edit":
      if (rest.length) throw new Error("config edit accepts no arguments");
      await editConfig(config, path);
      break;
    default:
      throw new Error("config requires show, validate, set, or edit");
  }
}
