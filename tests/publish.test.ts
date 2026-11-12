import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addedLines, validateInlineLocations } from "../src/diff.ts";
import type { Review } from "../src/findings.ts";
import type { PullRequest } from "../src/github.ts";
import { reviewPayload, verifyUnchanged } from "../src/publish.ts";

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

test("draft review payload omits the public event and stays pinned to the head", () => {
  expect(reviewPayload(pr, review)).toEqual({
    commit_id: pr.headRefOid,
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
  expect(reviewPayload(pr, review, true)).toMatchObject({ event: "COMMENT" });
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

test("GitHub receives a pending review, then a COMMENT submission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rprr-review-api-"));
  const executable = join(directory, "gh");
  const capture = join(directory, "payload.json");
  const script = `#!/bin/sh
if [ "$1" = pr ]; then
  printf '%s\n' "$RPRR_TEST_PR"
elif [ "$1" = api ] && [ "$2" = user ]; then
  printf '%s\n' 'ryan'
elif [ "$1" = api ] && [ "$3" = --paginate ]; then
  printf '%s\n' "$RPRR_TEST_REVIEWS"
elif [ "$1" = api ]; then
  cat > "$RPRR_TEST_CAPTURE"
  printf '%s\n' "$RPRR_TEST_RESPONSE"
else
  exit 1
fi
`;
  await writeFile(executable, script);
  await chmod(executable, 0o755);
  const prResponse = {
    url: pr.url,
    number: pr.number,
    title: pr.title,
    state: pr.state,
    body: pr.body,
    headRefOid: pr.headRefOid,
    baseRefOid: pr.baseRefOid,
  };
  const baseEnv = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    RPRR_TEST_PR: JSON.stringify(prResponse),
    RPRR_TEST_CAPTURE: capture,
  };
  const source = fileURLToPath(new URL("../src/publish.ts", import.meta.url));
  async function call(code: string, reviews: unknown, state: string) {
    const child = Bun.spawn([process.execPath, "-e", code], {
      env: {
        ...baseEnv,
        RPRR_TEST_REVIEWS: JSON.stringify(reviews),
        RPRR_TEST_RESPONSE: JSON.stringify({
          id: 42,
          state,
          html_url: `${pr.url}#pullrequestreview-42`,
        }),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(stderr);
    return stdout.trim() === "undefined" ? undefined : JSON.parse(stdout);
  }
  try {
    const create = `import { postReview } from ${JSON.stringify(source)}; console.log(JSON.stringify(await postReview(${JSON.stringify(pr)}, ${JSON.stringify(review)}, ${JSON.stringify(diff)})));`;
    expect((await call(create, [[]], "PENDING")).state).toBe("PENDING");
    expect(JSON.parse(await readFile(capture, "utf8"))).not.toHaveProperty(
      "event",
    );
    const createPublic = `import { postReview } from ${JSON.stringify(source)}; console.log(JSON.stringify(await postReview(${JSON.stringify(pr)}, ${JSON.stringify(review)}, ${JSON.stringify(diff)}, true)));`;
    expect((await call(createPublic, [[]], "COMMENTED")).state).toBe(
      "COMMENTED",
    );
    expect(JSON.parse(await readFile(capture, "utf8"))).toHaveProperty(
      "event",
      "COMMENT",
    );
    const pending = [
      [
        {
          id: 42,
          state: "PENDING",
          body: "RPRR review (non-approving)\n\nFound one issue",
          commit_id: pr.headRefOid,
          html_url: `${pr.url}#pullrequestreview-42`,
          user: { login: "ryan" },
        },
      ],
    ];
    const submit = `import { submitExistingDraft } from ${JSON.stringify(source)}; console.log(JSON.stringify(await submitExistingDraft(${JSON.stringify(pr.url)})));`;
    expect((await call(submit, pending, "COMMENTED")).postedReview.state).toBe(
      "COMMENTED",
    );
    expect(JSON.parse(await readFile(capture, "utf8"))).toEqual({
      event: "COMMENT",
    });
    const foreign = [[{ ...pending[0]?.[0], user: { login: "someone-else" } }]];
    expect(await call(submit, foreign, "COMMENTED")).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
