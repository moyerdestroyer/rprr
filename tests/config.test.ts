import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, createConfig, loadConfig } from "../src/config.ts";
import { initializeState } from "../src/state.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rprr-test-"));
  temporaryDirectories.push(root);
  return root;
}

const sampleConfig: Config = {
  agent: { command: "example-agent", args: ["acp"] },
  github: { trigger: "review-request" },
  review: { publish: true, timeoutSeconds: 900, maxFindings: 20 },
};

test("config is validated and never overwritten", async () => {
  const path = join(await temporaryPath(), "config", "rprr", "config.json");
  await createConfig(sampleConfig, path);
  expect(await loadConfig(path)).toEqual(sampleConfig);
  await expect(createConfig(sampleConfig, path)).rejects.toThrow();
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(sampleConfig);
});

test("SQLite state initializes idempotently with review uniqueness", async () => {
  const path = join(await temporaryPath(), "state", "rprr", "reviews.sqlite");
  await initializeState(path);
  await initializeState(path);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const db = new Database(path);
  try {
    const insert = db.query(
      "INSERT INTO reviews (repository, pr_number, head_sha, status) VALUES (?, ?, ?, ?)",
    );
    insert.run("org/repo", 123, "sha", "pending");
    expect(() => insert.run("org/repo", 123, "sha", "pending")).toThrow();
  } finally {
    db.close();
  }
});
