import { expect, test } from "bun:test";
import { access, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/acp.ts";
import {
  parseReview,
  type Review,
  validateFindingLocations,
} from "../src/findings.ts";
import { loadPullRequest } from "../src/github.ts";

test("review response validates finding paths and limit", () => {
  const valid: Review = {
    summary: "Found an issue",
    findings: [
      {
        file: "src/main.ts",
        line: 3,
        severity: "high",
        title: "Broken behavior",
        message: "This fails for empty input.",
      },
    ],
  };
  expect(parseReview(JSON.stringify(valid), 1)).toEqual(valid);
  expect(
    parseReview(
      `Checking files...\n${JSON.stringify(valid)}\ntaste learning failed`,
      1,
    ),
  ).toEqual(valid);
  expect(() =>
    parseReview(`${JSON.stringify(valid)}\nStill reviewing the PR`, 1),
  ).toThrow();
  expect(() => parseReview(JSON.stringify(valid), 0)).toThrow();
  expect(() =>
    parseReview(
      JSON.stringify({
        ...valid,
        findings: [{ ...valid.findings[0], file: "../secret" }],
      }),
      1,
    ),
  ).toThrow();
});

test("PR selector rejects command options before invoking gh", async () => {
  await expect(loadPullRequest("--web")).rejects.toThrow();
});

test("finding locations must resolve to text lines inside the checkout", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "rprr-findings-test-"));
  const outside = await mkdtemp(join(tmpdir(), "rprr-outside-test-"));
  const review: Review = {
    summary: "Found an issue",
    findings: [
      {
        file: "main.ts",
        line: 2,
        severity: "high",
        title: "Issue",
        message: "Details",
      },
    ],
  };
  const finding = review.findings[0];
  if (!finding) throw new Error("Test finding is missing");
  try {
    await writeFile(join(checkout, "main.ts"), "one\ntwo\n");
    await validateFindingLocations(review, checkout);
    finding.line = 3;
    await expect(validateFindingLocations(review, checkout)).rejects.toThrow();
    await symlink(join(outside, "secret.ts"), join(checkout, "escape.ts"));
    await writeFile(join(outside, "secret.ts"), "secret\n");
    finding.file = "escape.ts";
    finding.line = 1;
    await expect(validateFindingLocations(review, checkout)).rejects.toThrow();
  } finally {
    await rm(checkout, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("ACP review denies edits and cannot write to checkout", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "rprr-acp-test-"));
  const fixture = fileURLToPath(
    new URL("./fixtures/agent.ts", import.meta.url),
  );
  try {
    const output = await runAgent(
      { command: process.execPath, args: [fixture] },
      checkout,
      "Review this change",
      10,
    );
    expect(parseReview(output, 1).summary).toBe("write blocked; reject");
    await expect(access(join(checkout, "should-not-exist"))).rejects.toThrow();
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
});
