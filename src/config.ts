import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";

const configSchema = z.strictObject({
  schemaVersion: z.literal(1).default(1),
  agent: z.strictObject({
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()).optional(),
  }),
  github: z.strictObject({ trigger: z.literal("review-request") }),
  review: z.strictObject({
    publish: z.boolean(),
    timeoutSeconds: z.number().int().positive(),
    maxFindings: z.number().int().positive(),
    promptFile: z.string().min(1).optional(),
    skill: z.string().min(1).optional(),
  }),
});

export type Config = z.infer<typeof configSchema>;

export function validateConfig(data: unknown): Config {
  return configSchema.parse(data);
}

function xdgRoot(variable: string, fallback: string): string {
  const value = process.env[variable];
  if (!value) return fallback;
  if (!isAbsolute(value))
    throw new Error(`${variable} must be an absolute path`);
  return value;
}

export function appPaths() {
  const home = homedir();
  return {
    config: join(
      xdgRoot("XDG_CONFIG_HOME", join(home, ".config")),
      "rprr",
      "config.json",
    ),
    state: join(
      xdgRoot("XDG_STATE_HOME", join(home, ".local", "state")),
      "rprr",
      "reviews.sqlite",
    ),
    cache: join(xdgRoot("XDG_CACHE_HOME", join(home, ".cache")), "rprr"),
  };
}

export async function loadConfig(path = appPaths().config): Promise<Config> {
  const data = JSON.parse(await readFile(path, "utf8"));
  return validateConfig(data);
}

export async function createConfig(
  config: Config,
  path = appPaths().config,
): Promise<void> {
  const validated = configSchema.parse(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

export async function saveConfig(
  config: Config,
  path = appPaths().config,
): Promise<"created" | "updated" | "unchanged"> {
  const validated = configSchema.parse(config);
  const content = `${JSON.stringify(validated, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let previous: string | undefined;
  try {
    previous = await readFile(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  if (previous === content) return "unchanged";
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    if (previous !== undefined) {
      await copyFile(path, `${path}.bak`);
      await chmod(`${path}.bak`, 0o600);
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return previous === undefined ? "created" : "updated";
}
