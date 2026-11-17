import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import type { Review } from "../src/findings.ts";
import type { PullRequest } from "../src/github.ts";
import { reviewChunks } from "../src/review-chunks.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const config: Config = {
  schemaVersion: 1,
  agent: { command: "fixture", args: [] },
  github: { trigger: "review-request" },
  review: { timeoutSeconds: 30, maxFindings: 1 },
};
const pr: PullRequest = {
  url: "https://github.com/org/repo/pull/1",
  repository: "org/repo",
  number: 1,
  title: "Test",
  body: "Test",
  state: "OPEN",
  headRefOid: "a".repeat(40),
  baseRefOid: "b".repeat(40),
};
const diff =
  "diff --git a/code.ts b/code.ts\n--- a/code.ts\n+++ b/code.ts\n@@ -1 +1,2 @@\n-old\n+first\n+second\n";
const finding: Review["findings"][number] = {
  file: "code.ts",
  line: 1,
  severity: "low",
  title: "Issue",
  message: "Evidence",
};
async function checkout() {
  const path = await mkdtemp(join(tmpdir(), "rprr-chunks-"));
  roots.push(path);
  await writeFile(join(path, "code.ts"), "first\nsecond\n");
  return {
    path,
    changedFiles: ["code.ts", "generated.map"],
    excludedFiles: ["generated.map"],
  };
}

test("chunks share a deadline, validate locations, deduplicate and retain highest severity", async () => {
  let calls = 0;
  let restores = 0;
  const budgets: number[] = [];
  const result = await reviewChunks(
    pr,
    await checkout(),
    [diff, diff, diff],
    config,
    "Review",
    async (_agent, _cwd, prompt, seconds) => {
      expect(restores).toBe(calls);
      calls++;
      expect(prompt).toContain(`"chunk":${calls}`);
      budgets.push(seconds);
      await Bun.sleep(5);
      return JSON.stringify({
        summary: `Reviewed ${calls}`,
        findings: [
          {
            ...finding,
            ...(calls === 3 ? { line: 2, severity: "critical" } : {}),
          },
        ],
      });
    },
    async () => {
      restores++;
    },
  );
  expect(budgets[2]).toBeLessThan(budgets[0] ?? 0);
  expect(restores).toBe(3);
  expect(result.findings).toMatchObject([{ line: 2, severity: "critical" }]);
  expect(result.summary).toContain("1 additional findings omitted");
  expect(result.summary).toContain("1/2 changed files included in 3 chunk(s)");
  expect(result.summary).toContain("generated.map");
});

test("failed or invalid chunks never return a partial review", async () => {
  const work = await checkout();
  let calls = 0;
  await expect(
    reviewChunks(
      pr,
      work,
      [diff, diff],
      config,
      "Review",
      async () => {
        if (++calls === 2) throw new Error("agent unavailable");
        return JSON.stringify({ summary: "Clear", findings: [] });
      },
      async () => {},
    ),
  ).rejects.toThrow("agent unavailable");
  await expect(
    reviewChunks(
      pr,
      work,
      [diff],
      config,
      "Review",
      async () =>
        JSON.stringify({
          summary: "Issue",
          findings: [{ ...finding, line: 3 }],
        }),
      async () => {},
    ),
  ).rejects.toThrow("not on an added PR line");
});

test("fully excluded changes report zero coverage without launching an agent", async () => {
  const work = await checkout();
  work.excludedFiles = work.changedFiles;
  const result = await reviewChunks(
    pr,
    work,
    [],
    config,
    "Review",
    async () => {
      throw new Error("Must not launch");
    },
  );
  expect(result.summary).toContain("0/2 changed files included in 0 chunk(s)");
  expect(result.summary).toContain("No included diff to review");
  expect(result.findings).toEqual([]);
});

test("a depleted deadline stops before another chunk", async () => {
  let calls = 0;
  await expect(
    reviewChunks(
      pr,
      await checkout(),
      [diff, diff],
      { ...config, review: { ...config.review, timeoutSeconds: 0.01 } },
      "Review",
      async () => {
        calls++;
        await Bun.sleep(20);
        return JSON.stringify({ summary: "Clear", findings: [] });
      },
      async () => {},
    ),
  ).rejects.toThrow("before all diff chunks");
  expect(calls).toBe(1);
});
