import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import type { PullRequest, RemoteReview } from "../src/github.ts";
import { pollRequested } from "../src/poll.ts";
import { ReviewStore } from "../src/state.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function storePath(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rprr-poll-test-"));
  directories.push(path);
  return join(path, "reviews.sqlite");
}

const config: Config = {
  schemaVersion: 1,
  agent: { command: "fixture", args: [] },
  github: { trigger: "review-request" },
  review: { timeoutSeconds: 30, maxFindings: 20 },
};

const pr: PullRequest = {
  url: "https://github.com/org/repo/pull/12",
  repository: "org/repo",
  number: 12,
  title: "Change",
  state: "OPEN",
  body: null,
  headRefOid: "a".repeat(40),
  baseRefOid: "b".repeat(40),
};

test("claims each head once, retries failures, and recovers posted reviews", async () => {
  const path = await storePath();
  const store = await ReviewStore.open(path);
  let current = pr;
  let requested = true;
  let posted: RemoteReview | undefined;
  let reviewCalls = 0;
  let failReview = false;
  const notifications: string[] = [];
  const deps = {
    load: async () => current,
    requested: async () => requested,
    existing: async () => posted,
    notify: async (requestedPr: PullRequest) => {
      notifications.push(requestedPr.url);
    },
    review: async (
      _url: string,
      _config: Config,
      _mode?: "draft" | "publish" | "dry-run",
      before?: (pr: PullRequest) => Promise<void>,
    ) => {
      reviewCalls++;
      await before?.(current);
      if (failReview) throw new Error("agent failed");
      posted = {
        id: reviewCalls,
        url: `${current.url}#pullrequestreview-${reviewCalls}`,
        state: "PENDING",
      };
      return {
        url: current.url,
        repository: current.repository,
        number: current.number,
        head: current.headRefOid,
        review: { summary: "Clear", findings: [] },
        postedReview: posted,
      };
    },
  };
  try {
    expect(
      (await pollRequested([pr.url], "ryan", config, store, deps)).completed,
    ).toBe(1);
    expect(
      (await pollRequested([pr.url], "ryan", config, store, deps)).skipped,
    ).toBe(1);
    expect(reviewCalls).toBe(1);
    expect(notifications).toEqual([pr.url]);
    expect(store.drafts()).toHaveLength(1);

    current = { ...pr, headRefOid: "c".repeat(40) };
    posted = undefined;
    failReview = true;
    expect(
      (await pollRequested([pr.url], "ryan", config, store, deps)).failed[0]
        ?.error,
    ).toBe("agent failed");
    expect(store.recent()[0]?.status).toBe("failed");
    failReview = false;
    expect(
      (await pollRequested([pr.url], "ryan", config, store, deps)).completed,
    ).toBe(1);
    expect(store.recent()[0]?.review_id).toBe(3);
    expect(store.recent()[0]?.review_state).toBe("PENDING");
    expect(notifications).toHaveLength(2);

    current = { ...pr, headRefOid: "d".repeat(40) };
    posted = {
      id: 99,
      url: `${pr.url}#pullrequestreview-99`,
      state: "PENDING",
    };
    requested = false;
    expect(
      (await pollRequested([], "ryan", config, store, deps)).completed,
    ).toBe(0);
    const claim = store.claim(
      current.repository,
      current.number,
      current.headRefOid,
      "ryan",
      30,
    );
    if (!claim) throw new Error("Expected claim");
    store.fail(claim, "crash after publish");
    expect(
      (await pollRequested([], "ryan", config, store, deps)).completed,
    ).toBe(1);
    expect(store.recent()[0]?.review_id).toBe(99);
    expect(reviewCalls).toBe(3);
    expect(notifications).toHaveLength(3);
  } finally {
    store.close();
  }
});

test("stale claims can be reclaimed without an old worker completing them", async () => {
  const path = await storePath();
  const store = await ReviewStore.open(path);
  try {
    const old = store.claim("org/repo", 1, "head", "ryan", 30);
    if (!old) throw new Error("Expected claim");
    expect(store.claim("org/repo", 1, "head", "ryan", 30)).toBeUndefined();
    const db = new Database(path);
    db.query("UPDATE reviews SET started_at = ? WHERE id = ?").run(
      "2000-01-01T00:00:00.000Z",
      old.id,
    );
    db.close();
    expect(store.recoverable(30)).toEqual([
      "https://github.com/org/repo/pull/1",
    ]);
    const next = store.claim("org/repo", 1, "head", "ryan", 30);
    if (!next) throw new Error("Expected replacement claim");
    expect(store.isActive(old)).toBe(false);
    expect(store.isActive(next)).toBe(true);
    expect(() => store.complete(old, 1)).toThrow();
    store.complete(next, 2);
    expect(store.claim("org/repo", 1, "head", "ryan", 30)).toBeUndefined();
  } finally {
    store.close();
  }
});

test("withdrawn requests do not publish", async () => {
  const store = await ReviewStore.open(await storePath());
  let checks = 0;
  const deps = {
    load: async () => pr,
    requested: async () => ++checks === 1,
    existing: async () => undefined,
    review: async (
      _url: string,
      _config: Config,
      _mode?: "draft" | "publish" | "dry-run",
      before?: (pr: PullRequest) => Promise<void>,
    ) => {
      await before?.(pr);
      throw new Error("Should not publish");
    },
  };
  try {
    const result = await pollRequested([pr.url], "ryan", config, store, deps);
    expect(result.failed[0]?.error).toBe("Review request was withdrawn");
    expect(store.recent()[0]?.status).toBe("failed");
  } finally {
    store.close();
  }
});

test("the first poll drafts two existing requests even if desktop notification fails", async () => {
  const store = await ReviewStore.open(await storePath());
  const second = {
    ...pr,
    number: 13,
    url: "https://github.com/org/repo/pull/13",
  };
  const reviewed: string[] = [];
  const deps = {
    load: async (url: string) => (url === second.url ? second : pr),
    requested: async () => true,
    existing: async () => undefined,
    notify: async () => {
      throw new Error("No desktop session");
    },
    review: async (
      url: string,
      _config: Config,
      _mode?: "draft" | "publish" | "dry-run",
      before?: (pr: PullRequest) => Promise<void>,
    ) => {
      const requestedPr = url === second.url ? second : pr;
      await before?.(requestedPr);
      reviewed.push(url);
      return {
        url,
        repository: requestedPr.repository,
        number: requestedPr.number,
        head: requestedPr.headRefOid,
        review: { summary: "ready", findings: [] },
        postedReview: {
          id: requestedPr.number,
          url: `${url}#pullrequestreview-${requestedPr.number}`,
          state: "PENDING" as const,
        },
      };
    },
  };
  try {
    const result = await pollRequested(
      [pr.url, second.url],
      "ryan",
      config,
      store,
      deps,
    );
    expect(result).toMatchObject({ discovered: 2, completed: 2, failed: [] });
    expect(reviewed).toEqual([pr.url, second.url]);
    expect(store.drafts()).toHaveLength(2);
  } finally {
    store.close();
  }
});
