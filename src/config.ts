import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";

const configSchema = z.object({
  agent: z.object({
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()).optional(),
  }),
  github: z.object({ trigger: z.literal("review-request") }),
  review: z.object({
    publish: z.boolean(),
    timeoutSeconds: z.number().int().positive(),
    maxFindings: z.number().int().positive(),
  }),
});

export type Config = z.infer<typeof configSchema>;

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
  return configSchema.parse(data);
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
