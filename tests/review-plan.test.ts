import { expect, test } from "bun:test";
import { addedLines } from "../src/diff.ts";
import { diffScope } from "../src/diff-scope.ts";
import {
  planReview,
  reviewBudgetKey,
  reviewByteBudget,
} from "../src/review-plan.ts";

const config = {
  timeoutSeconds: 30,
  maxFindings: 20,
  maxDiffBytes: 200,
  maxChunks: 20,
};
const header = "diff --git a/code.ts b/code.ts\n--- a/code.ts\n+++ b/code.ts\n";
const first = `@@ -1 +1 @@\n-old\n+${"a".repeat(60)}\n`;
const second = `@@ -20 +20 @@\n-old\n+${"b".repeat(60)}\n`;

test("large files split at hunk boundaries with original line numbers", () => {
  const plan = planReview(header + first + second, config);
  expect(plan.omittedFiles).toEqual([]);
  expect(plan.chunks).toEqual([header + first, header + second]);
  expect(plan.chunks.every((chunk) => Buffer.byteLength(chunk) <= 200)).toBe(
    true,
  );
  expect([...(addedLines(plan.chunks.join("")).get("code.ts") ?? [])]).toEqual([
    1, 20,
  ]);
});

test("whole files pack together without dropping binary or deletion sections", () => {
  const binary =
    "diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n";
  const deleted =
    "diff --git a/old.ts b/old.ts\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n";
  const diff = header + first + binary + deleted;
  expect(
    planReview(diff, { ...config, maxDiffBytes: 250 }).chunks.join(""),
  ).toBe(diff);
  expect(planReview("", config)).toEqual({ chunks: [], omittedFiles: [] });
});

test("oversized files are omitted and smaller files still pack", () => {
  const small = "diff --git a/small.ts b/small.ts\n+ok\n";
  const packed = planReview(header + first + second + small, {
    ...config,
    maxChunks: 1,
  });
  expect(packed.omittedFiles).toEqual(["code.ts"]);
  expect(packed.chunks).toEqual([small]);
  const wide = planReview(header + first, { ...config, maxDiffBytes: 100 });
  expect(wide.omittedFiles).toEqual(["code.ts"]);
  expect(wide.chunks).toEqual([]);
  expect(planReview(header + "x".repeat(300), config).omittedFiles).toEqual([
    "code.ts",
  ]);
  const emoji = planReview(
    header + first.replace("a".repeat(60), "💡".repeat(60)),
    config,
  );
  expect(emoji.omittedFiles).toEqual(["code.ts"]);
  expect(emoji.chunks).toEqual([]);
});

test("retry keys depend on review budgets and exclusions, not unrelated settings", () => {
  const key = reviewBudgetKey(config);
  expect(reviewBudgetKey({ ...config, maxFindings: 10 })).toBe(key);
  expect(reviewBudgetKey({ ...config, maxChunks: 2 })).not.toBe(key);
  expect(reviewBudgetKey({ ...config, excludePaths: ["**/*.map"] })).not.toBe(
    key,
  );
  expect(reviewByteBudget(config)).toBe(4_000);
  expect(reviewByteBudget({ timeoutSeconds: 30, maxFindings: 20 })).toBe(
    10_000_000,
  );
});

test("quoted diff paths and repeated file sections preserve added lines", () => {
  const diff =
    'diff --git "a/a\\tb" "b/a\\tb"\n--- "a/a\\tb"\n+++ "b/a\\tb"\n@@ -0,0 +1 @@\n+added\n';
  expect(addedLines(diff).get("a\tb")?.has(1)).toBe(true);
});

test("exclusions cover both sides of renames and treat special filenames literally", () => {
  const result = diffScope(
    "R100\0old.map\0renamed.txt\0M\0a [1].map\0A\0keep.ts\0",
    ["**/*.map"],
  );
  expect(result.changedFiles).toEqual(["renamed.txt", "a [1].map", "keep.ts"]);
  expect(result.excludedFiles).toEqual(["renamed.txt", "a [1].map"]);
  expect(result.excludedPaths).toEqual(["old.map", "renamed.txt", "a [1].map"]);
  expect(diffScope("", []).changedFiles).toEqual([]);
  expect(() => diffScope("M\0", [])).toThrow("Invalid Git");
  expect(() => diffScope("R100\0old\0", [])).toThrow("Invalid Git rename");
});
