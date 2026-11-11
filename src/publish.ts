import { z } from "zod";
import { validateInlineLocations } from "./diff.ts";
import type { Review } from "./findings.ts";
import {
  existingReview,
  loadPullRequest,
  type PullRequest,
  reviewMarker,
} from "./github.ts";

const responseSchema = z.object({
  id: z.number().int().positive(),
  state: z.literal("COMMENTED"),
  html_url: z.string().url(),
});

export function reviewPayload(pr: PullRequest, review: Review) {
  return {
    commit_id: pr.headRefOid,
    event: "COMMENT" as const,
    body: `${reviewMarker}\n\n${review.summary}`,
    comments: review.findings.map((finding) => ({
      path: finding.file,
      line: finding.line,
      side: "RIGHT" as const,
      body: `**${finding.severity.toUpperCase()}: ${finding.title}**\n\n${finding.message}`,
    })),
  };
}

export function verifyUnchanged(
  observed: PullRequest,
  current: PullRequest,
): void {
  if (current.state !== "OPEN")
    throw new Error("PR is not open; review was not posted");
  if (current.headRefOid !== observed.headRefOid)
    throw new Error(
      "PR head changed before publication; review was not posted",
    );
  if (current.baseRefOid !== observed.baseRefOid)
    throw new Error(
      "PR base changed before publication; review was not posted",
    );
}

export async function publishReview(
  pr: PullRequest,
  review: Review,
  diff: string,
): Promise<{ id: number; url: string }> {
  validateInlineLocations(review, diff);
  const current = await loadPullRequest(pr.url);
  verifyUnchanged(pr, current);
  const previous = await existingReview(pr);
  if (previous) return previous;
  const endpoint = `repos/${pr.repository}/pulls/${pr.number}/reviews`;
  const child = Bun.spawn(
    ["gh", "api", endpoint, "--method", "POST", "--input", "-"],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  child.stdin.write(JSON.stringify(reviewPayload(pr, review)));
  child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(
      `GitHub rejected review: ${stderr.trim() || stdout.trim()}`,
    );
  const result = responseSchema.parse(JSON.parse(stdout));
  return { id: result.id, url: result.html_url };
}
