import { z } from "zod";
import { validateInlineLocations } from "./diff.ts";
import type { Review } from "./findings.ts";
import {
  existingReview,
  loadPullRequest,
  type PullRequest,
  type RemoteReview,
  reviewIsCurrent,
  reviewMarker,
} from "./github.ts";

const responseSchema = z.object({
  id: z.number().int().positive(),
  state: z.enum(["PENDING", "COMMENTED"]),
  html_url: z.string().url(),
});

export function reviewPayload(
  pr: PullRequest,
  review: Review,
  publish = false,
) {
  return {
    commit_id: pr.headRefOid,
    ...(publish ? { event: "COMMENT" as const } : {}),
    body: `${reviewMarker}\n<!-- rprr-base:${pr.baseRefOid} -->\n\n${review.summary}`,
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

async function post(endpoint: string, payload: unknown): Promise<RemoteReview> {
  const child = Bun.spawn(
    ["gh", "api", endpoint, "--method", "POST", "--input", "-"],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  child.stdin.write(JSON.stringify(payload));
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
  return { id: result.id, url: result.html_url, state: result.state };
}

async function deletePending(pr: PullRequest, reviewId: number): Promise<void> {
  const endpoint = `repos/${pr.repository}/pulls/${pr.number}/reviews/${reviewId}`;
  const child = Bun.spawn(["gh", "api", endpoint, "--method", "DELETE"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(
      `GitHub rejected draft deletion: ${stderr.trim() || stdout.trim()}`,
    );
}

async function reuseOrReplace(
  pr: PullRequest,
  previous: RemoteReview,
  publish: boolean,
  onDraftDeleted?: (reviewId: number) => Promise<void>,
): Promise<RemoteReview | undefined> {
  if (reviewIsCurrent(previous, pr)) {
    if (publish && previous.state === "PENDING") {
      const submitted = await post(
        `repos/${pr.repository}/pulls/${pr.number}/reviews/${previous.id}/events`,
        { event: "COMMENT" },
      );
      if (submitted.state !== "COMMENTED")
        throw new Error("GitHub did not submit the pending review");
      return submitted;
    }
    return previous;
  }
  if (previous.state === "COMMENTED") {
    return previous.baseSha === undefined ? previous : undefined;
  }
  verifyUnchanged(pr, await loadPullRequest(pr.url));
  const pending = await existingReview(pr);
  if (
    !pending ||
    pending.id !== previous.id ||
    pending.state !== "PENDING" ||
    reviewIsCurrent(pending, pr)
  )
    throw new Error("Pending review changed before replacement");
  await deletePending(pr, previous.id);
  await onDraftDeleted?.(previous.id);
  return undefined;
}

export async function postReview(
  pr: PullRequest,
  review: Review,
  diff: string,
  publish = false,
  onDraftDeleted?: (reviewId: number) => Promise<void>,
): Promise<RemoteReview> {
  validateInlineLocations(review, diff);
  const current = await loadPullRequest(pr.url);
  verifyUnchanged(pr, current);
  const previous = await existingReview(pr);
  if (previous) {
    const reused = await reuseOrReplace(pr, previous, publish, onDraftDeleted);
    if (reused) return reused;
  }
  verifyUnchanged(pr, await loadPullRequest(pr.url));
  const endpoint = `repos/${pr.repository}/pulls/${pr.number}/reviews`;
  const result = await post(endpoint, reviewPayload(pr, review, publish));
  const expected = publish ? "COMMENTED" : "PENDING";
  if (result.state !== expected)
    throw new Error(`GitHub returned ${result.state} instead of ${expected}`);
  return result;
}

export async function submitExistingDraft(selector: string): Promise<
  | {
      url: string;
      repository: string;
      number: number;
      head: string;
      base: string;
      postedReview: RemoteReview;
    }
  | undefined
> {
  const pr = await loadPullRequest(selector);
  const existing = await existingReview(pr);
  if (existing?.state !== "PENDING") return undefined;
  if (!reviewIsCurrent(existing, pr)) return undefined;
  verifyUnchanged(pr, await loadPullRequest(pr.url));
  const pending = await existingReview(pr);
  if (
    !pending ||
    pending.id !== existing.id ||
    pending.state !== "PENDING" ||
    !reviewIsCurrent(pending, pr)
  )
    throw new Error("Pending review changed before submission");
  const submitted = await post(
    `repos/${pr.repository}/pulls/${pr.number}/reviews/${existing.id}/events`,
    { event: "COMMENT" },
  );
  if (submitted.state !== "COMMENTED")
    throw new Error("GitHub did not submit the pending review");
  return {
    url: pr.url,
    repository: pr.repository,
    number: pr.number,
    head: pr.headRefOid,
    base: pr.baseRefOid,
    postedReview: submitted,
  };
}
