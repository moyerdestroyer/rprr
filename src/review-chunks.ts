import { runAgent } from "./acp.ts";
import type { Config } from "./config.ts";
import { validateInlineLocations } from "./diff.ts";
import {
  parseReview,
  type Review,
  validateFindingLocations,
} from "./findings.ts";
import { type PullRequest, restoreCheckout } from "./github.ts";
import { composeReviewPrompt } from "./prompt.ts";

type Checkout = {
  path: string;
  changedFiles: string[];
  excludedFiles: string[];
};

function mergedReview(reviews: Review[], maxFindings: number): Review {
  const unique = new Map<string, Review["findings"][number]>();
  for (const finding of reviews.flatMap((review) => review.findings))
    unique.set(JSON.stringify(finding), finding);
  const priority = { critical: 0, high: 1, medium: 2, low: 3 };
  const findings = [...unique.values()].sort(
    (a, b) =>
      priority[a.severity] - priority[b.severity] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.title.localeCompare(b.title) ||
      a.message.localeCompare(b.message),
  );
  const summaries =
    reviews.length === 1
      ? (reviews[0]?.summary ?? "")
      : reviews
          .map((review, index) => `Chunk ${index + 1}: ${review.summary}`)
          .join("\n\n");
  const omitted = Math.max(0, findings.length - maxFindings);
  return {
    summary: `${omitted ? `Finding limit: ${omitted} additional findings omitted; highest severity findings retained.\n\n` : ""}${summaries.slice(0, 40_000) || "No included diff to review."}${summaries.length > 40_000 ? "\n\nChunk summaries truncated." : ""}`,
    findings: findings.slice(0, maxFindings),
  };
}

function coverage(checkout: Checkout, chunks: number): string {
  const included = checkout.changedFiles.length - checkout.excludedFiles.length;
  const excluded = checkout.excludedFiles;
  const listed = excluded
    .slice(0, 20)
    .map((file) =>
      JSON.stringify(file.length > 200 ? `${file.slice(0, 200)}…` : file),
    )
    .join(", ");
  return `Review coverage: ${included}/${checkout.changedFiles.length} changed files included in ${chunks} chunk(s). ${excluded.length} file(s) excluded by review.excludePaths.${excluded.length ? ` Excluded paths: ${listed}${excluded.length > 20 ? `, and ${excluded.length - 20} more (see dry-run coverage).` : "."}` : ""}`;
}

export async function reviewChunks(
  pr: PullRequest,
  checkout: Checkout,
  chunks: string[],
  config: Config,
  instructions: string,
  agent = runAgent,
  restore = restoreCheckout,
): Promise<Review> {
  const deadline = Date.now() + config.review.timeoutSeconds * 1000;
  const reviews: Review[] = [];
  for (const [index, diff] of chunks.entries()) {
    const remaining = (deadline - Date.now()) / 1000;
    if (remaining <= 0)
      throw new Error("Review timed out before all diff chunks were reviewed");
    const context = JSON.stringify({
      url: pr.url,
      title: pr.title,
      description: pr.body ?? "",
      head: pr.headRefOid,
      chunk: index + 1,
      chunks: chunks.length,
      scope:
        "Review this diff chunk; report findings only on its added lines. Other changes are reviewed separately. Do not claim whole-PR coverage.",
      diff,
    });
    const output = await agent(
      config.agent,
      checkout.path,
      composeReviewPrompt(instructions, context),
      remaining,
      config.review.skill,
    );
    await restore(checkout.path, pr.headRefOid);
    const review = parseReview(output, config.review.maxFindings);
    validateInlineLocations(review, diff);
    await validateFindingLocations(review, checkout.path);
    reviews.push(review);
  }
  const result = mergedReview(reviews, config.review.maxFindings);
  // Keep the combined summary within GitHub's review body limit, preserving coverage.
  result.summary = `${coverage(checkout, chunks.length)}\n\n${result.summary}`;
  return result;
}
