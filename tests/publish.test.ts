import { expect, test } from "bun:test";
import { addedLines, validateInlineLocations } from "../src/diff.ts";
import type { Review } from "../src/findings.ts";
import type { PullRequest } from "../src/github.ts";
import { reviewPayload, verifyUnchanged } from "../src/publish.ts";
import { reviewPullRequest } from "../src/review.ts";

const diff = `diff --git a/src/file name.ts b/src/file name.ts
index 123..456 100644
--- a/src/file name.ts
+++ b/src/file name.ts
@@ -1,3 +1,4 @@
 unchanged
-old
+new
+extra
 unchanged
@@ -10,2 +11,2 @@
 unchanged
-old
+replacement
`;

const review: Review = {
  summary: "Found one issue",
  findings: [
    {
      file: "src/file name.ts",
      line: 3,
      severity: "high",
      title: "Broken path",
      message: "The new path is wrong.",
    },
  ],
};

const pr: PullRequest = {
  url: "https://github.com/example/repo/pull/2",
  repository: "example/repo",
  number: 2,
  title: "Change",
  state: "OPEN",
  body: null,
  headRefOid: "a".repeat(40),
  baseRefOid: "b".repeat(40),
};

test("inline comments require added lines in the correct file", () => {
  expect([...(addedLines(diff).get("src/file name.ts") ?? [])]).toEqual([
    2, 3, 12,
  ]);
  validateInlineLocations(review, diff);
  const finding = review.findings[0];
  if (!finding) throw new Error("Test finding is missing");
  const contextLine: Review = {
    ...review,
    findings: [{ ...finding, line: 1 }],
  };
  expect(() => validateInlineLocations(contextLine, diff)).toThrow();
});

test("review payload is pinned to the head and can only comment", () => {
  expect(reviewPayload(pr, review)).toEqual({
    commit_id: pr.headRefOid,
    event: "COMMENT",
    body: "RPRR review (non-approving)\n\nFound one issue",
    comments: [
      {
        path: "src/file name.ts",
        line: 3,
        side: "RIGHT",
        body: "**HIGH: Broken path**\n\nThe new path is wrong.",
      },
    ],
  });
});

test("publication rejects a moved PR head or base", () => {
  verifyUnchanged(pr, pr);
  expect(() => verifyUnchanged(pr, { ...pr, state: "CLOSED" })).toThrow(
    "not open",
  );
  expect(() =>
    verifyUnchanged(pr, { ...pr, headRefOid: "c".repeat(40) }),
  ).toThrow("head changed");
  expect(() =>
    verifyUnchanged(pr, { ...pr, baseRefOid: "c".repeat(40) }),
  ).toThrow("base changed");
});

test("publication disabled in config fails before accessing GitHub", async () => {
  await expect(
    reviewPullRequest(
      "1",
      {
        agent: { command: "no-agent", args: [] },
        github: { trigger: "review-request" },
        review: { publish: false, timeoutSeconds: 10, maxFindings: 1 },
      },
      true,
    ),
  ).rejects.toThrow("disabled");
});
