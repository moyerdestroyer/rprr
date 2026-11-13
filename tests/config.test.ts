import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Config,
  createConfig,
  loadConfig,
  validateConfig,
} from "../src/config.ts";
import { initializeState, ReviewStore } from "../src/state.ts";

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
  schemaVersion: 1,
  agent: { command: "example-agent", args: ["acp"] },
  github: { trigger: "review-request" },
  review: { timeoutSeconds: 900, maxFindings: 20 },
};

test("config is validated and never overwritten", async () => {
  const path = join(await temporaryPath(), "config", "rprr", "config.json");
  await createConfig(sampleConfig, path);
  expect(await loadConfig(path)).toEqual(sampleConfig);
  await expect(createConfig(sampleConfig, path)).rejects.toThrow();
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(sampleConfig);
});

test("legacy config drops the old publication switch", async () => {
  const path = join(await temporaryPath(), "config.json");
  const { schemaVersion: _version, ...legacy } = sampleConfig;
  await Bun.write(
    path,
    JSON.stringify({
      ...legacy,
      review: { ...legacy.review, publish: true },
    }),
  );
  expect(await loadConfig(path)).toEqual(sampleConfig);
});

test("configuration rejects unknown keys and unsupported schema versions", () => {
  expect(() => validateConfig({ ...sampleConfig, unexpected: true })).toThrow();
  expect(() => validateConfig({ ...sampleConfig, schemaVersion: 2 })).toThrow();
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

test("existing review databases gain the claim token column", async () => {
  const path = join(await temporaryPath(), "reviews.sqlite");
  const db = new Database(path, { create: true });
  db.exec(`CREATE TABLE reviews (
    id INTEGER PRIMARY KEY, repository TEXT NOT NULL, pr_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL, request_identity TEXT, status TEXT NOT NULL,
    started_at TEXT, completed_at TEXT, published_review_id INTEGER,
    error TEXT, UNIQUE (repository, pr_number, head_sha)
  )`);
  db.close();
  await initializeState(path);
  const migrated = new Database(path);
  try {
    const columns = migrated
      .query("PRAGMA table_info(reviews)")
      .all() as Array<{ name: string }>;
    expect(columns.some(({ name }) => name === "attempt_id")).toBe(true);
    expect(columns.some(({ name }) => name === "review_state")).toBe(true);
    expect(columns.some(({ name }) => name === "base_sha")).toBe(true);
  } finally {
    migrated.close();
  }
});

test("poll runs record success and failure for health reporting", async () => {
  const store = await ReviewStore.open(
    join(await temporaryPath(), "reviews.sqlite"),
  );
  try {
    const success = store.startPoll();
    store.finishPoll(success, {
      discovered: 2,
      completed: 1,
      skipped: 1,
      failed: 0,
    });
    expect(store.latestPoll()?.status).toBe("completed");
    expect(store.latestPoll()?.completed).toBe(1);
    const failure = store.startPoll();
    store.failPoll(failure, "gh unavailable");
    expect(store.latestPoll()?.error).toBe("gh unavailable");
  } finally {
    store.close();
  }
});

test("manual drafts are listed and disappear after publication", async () => {
  const store = await ReviewStore.open(
    join(await temporaryPath(), "reviews.sqlite"),
  );
  try {
    store.recordPosted("org/repo", 12, "a".repeat(40), 52, "PENDING");
    expect(store.drafts()).toMatchObject([
      { repository: "org/repo", pr_number: 12, review_id: 52 },
    ]);
    store.recordPosted("org/repo", 12, "a".repeat(40), 52, "COMMENTED");
    expect(store.drafts()).toEqual([]);
    expect(store.recent()[0]?.review_state).toBe("COMMENTED");
  } finally {
    store.close();
  }
});

test("a changed base permits a new claim for the same head", async () => {
  const store = await ReviewStore.open(
    join(await temporaryPath(), "reviews.sqlite"),
  );
  try {
    const first = store.claim("org/repo", 12, "head", "ryan", 30, "base-1");
    if (!first) throw new Error("Expected first claim");
    store.complete(first, 52, "PENDING");
    expect(
      store.claim("org/repo", 12, "head", "ryan", 30, "base-1"),
    ).toBeUndefined();
    const next = store.claim("org/repo", 12, "head", "ryan", 30, "base-2");
    if (!next) throw new Error("Expected claim after base change");
    store.clearDeletedDraft("org/repo", 12, 52);
    expect(store.drafts()).toEqual([]);
    store.complete(next, 53, "PENDING");
    expect(store.drafts()[0]).toMatchObject({
      base_sha: "base-2",
      review_id: 53,
    });
  } finally {
    store.close();
  }
});
