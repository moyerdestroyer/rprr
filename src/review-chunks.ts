import { runAgent } from "./acp.ts";
import type { Config } from "./config.ts";
import { validateInlineLocations } from "./diff.ts";
import { diffDestination } from "./diff-collect.ts";
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
  omittedFiles?: string[];
};

type Agent = typeof runAgent;

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

function named(files: string[]): string {
  const listed = files
    .slice(0, 20)
    .map((file) =>
      JSON.stringify(file.length > 200 ? `${file.slice(0, 200)}…` : file),
    )
    .join(", ");
  const more =
    files.length > 20
      ? `, and ${files.length - 20} more (see dry-run coverage)`
      : "";
  return `${listed}${more}.`;
}

function coverage(
  checkout: Checkout,
  chunks: number,
  contextOmitted: string[],
): string {
  const sizeOmitted = checkout.omittedFiles ?? [];
  const included = Math.max(
    0,
    checkout.changedFiles.length -
      checkout.excludedFiles.length -
      sizeOmitted.length -
      contextOmitted.length,
  );
  const excluded = checkout.excludedFiles;
  const size =
    sizeOmitted.length === 0
      ? ""
      : ` ${sizeOmitted.length} file(s) omitted because they exceed the review budget. Omitted paths: ${named(sizeOmitted)}`;
  const context =
    contextOmitted.length === 0
      ? ""
      : ` ${contextOmitted.length} file(s) omitted because the agent rejected the prompt size. Omitted paths: ${named(contextOmitted)}`;
  return `Review coverage: ${included}/${checkout.changedFiles.length} changed files included in ${chunks} chunk(s). ${excluded.length} file(s) excluded by review.excludePaths.${excluded.length ? ` Excluded paths: ${named(excluded)}` : ""}${size}${context}`;
}

function promptLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /context window|prompt exceeds/i.test(message);
}

function sectionsOf(diff: string): string[] {
  return diff.split(/(?=^diff --git )/m).filter(Boolean);
}

async function reviewDiff(
  diff: string,
  pr: PullRequest,
  checkout: Checkout,
  config: Config,
  instructions: string,
  agent: Agent,
  restore: typeof restoreCheckout,
  deadline: number,
  index: number,
  total: number,
  contextOmitted: string[],
): Promise<Review[]> {
  const remaining = (deadline - Date.now()) / 1000;
  if (remaining <= 0)
    throw new Error("Review timed out before all diff chunks were reviewed");
  const context = JSON.stringify({
    url: pr.url,
    title: pr.title,
    description: pr.body ?? "",
    head: pr.headRefOid,
    chunk: index + 1,
    chunks: total,
    scope:
      "Review this diff chunk; report findings only on its added lines. Other changes are reviewed separately. Do not claim whole-PR coverage.",
    diff,
  });
  let restored = false;
  try {
    const output = await agent(
      config.agent,
      checkout.path,
      composeReviewPrompt(instructions, context),
      remaining,
      config.review.skill,
    );
    await restore(checkout.path, pr.headRefOid);
    restored = true;
    const review = parseReview(output, config.review.maxFindings);
    validateInlineLocations(review, diff);
    await validateFindingLocations(review, checkout.path);
    return [review];
  } catch (error) {
    if (!restored) await restore(checkout.path, pr.headRefOid);
    if (!promptLimit(error)) throw error;
    const sections = sectionsOf(diff);
    if (sections.length <= 1) {
      contextOmitted.push(
        diffDestination(sections[0]?.split("\n")[0] ?? "") ?? "unknown",
      );
      return [];
    }
    const mid = Math.ceil(sections.length / 2);
    const left = await reviewDiff(
      sections.slice(0, mid).join(""),
      pr,
      checkout,
      config,
      instructions,
      agent,
      restore,
      deadline,
      index,
      total,
      contextOmitted,
    );
    const right = await reviewDiff(
      sections.slice(mid).join(""),
      pr,
      checkout,
      config,
      instructions,
      agent,
      restore,
      deadline,
      index,
      total,
      contextOmitted,
    );
    return [...left, ...right];
  }
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
  const contextOmitted: string[] = [];
  for (const [index, diff] of chunks.entries()) {
    reviews.push(
      ...(await reviewDiff(
        diff,
        pr,
        checkout,
        config,
        instructions,
        agent,
        restore,
        deadline,
        index,
        chunks.length,
        contextOmitted,
      )),
    );
  }
  const result = mergedReview(reviews, config.review.maxFindings);
  // Keep the combined summary within GitHub's review body limit, preserving coverage.
  result.summary = `${coverage(checkout, chunks.length, contextOmitted)}\n\n${result.summary}`;
  return result;
}
