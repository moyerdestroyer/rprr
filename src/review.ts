import type { Config } from "./config.ts";
import type { Review } from "./findings.ts";
import {
  checkoutPullRequest,
  loadPullRequest,
  type PullRequest,
  type RemoteReview,
} from "./github.ts";
import { ProcessOutputLimitError } from "./process.ts";
import { reviewInstructions } from "./prompt.ts";
import { postReview } from "./publish.ts";
import { reviewChunks } from "./review-chunks.ts";
import {
  planReview,
  ReviewLimitError,
  reviewByteBudget,
} from "./review-plan.ts";

async function checkoutForReview(pr: PullRequest, config: Config) {
  const byteBudget = reviewByteBudget(config.review);
  try {
    return await checkoutPullRequest(
      pr,
      config.review.excludePaths,
      byteBudget,
    );
  } catch (error) {
    if (!(error instanceof ProcessOutputLimitError)) throw error;
    throw new ReviewLimitError(
      `PR diff exceeds the review budget of ${byteBudget} bytes. Increase review.maxDiffBytes or review.maxChunks, or configure review.excludePaths; no review was posted.`,
    );
  }
}

export type ReviewMode = "draft" | "publish" | "dry-run";

export async function reviewPullRequest(
  selector: string,
  config: Config,
  mode: ReviewMode = "draft",
  beforePost?: (pr: PullRequest) => Promise<void>,
  onDraftDeleted?: (pr: PullRequest, reviewId: number) => Promise<void>,
): Promise<{
  url: string;
  repository: string;
  number: number;
  head: string;
  base: string;
  review: Review;
  coverage: { changedFiles: string[]; excludedFiles: string[]; chunks: number };
  postedReview?: RemoteReview;
}> {
  const pr = await loadPullRequest(selector);
  const checkout = await checkoutForReview(pr, config);
  try {
    const chunks = planReview(checkout.diff, config.review);
    const instructions = await reviewInstructions(config);
    const review = await reviewChunks(
      pr,
      checkout,
      chunks,
      config,
      instructions.text,
    );
    if (mode !== "dry-run") await beforePost?.(pr);
    const postedReview =
      mode !== "dry-run"
        ? await postReview(
            pr,
            review,
            checkout.diff,
            mode === "publish",
            (reviewId) => onDraftDeleted?.(pr, reviewId) ?? Promise.resolve(),
          )
        : undefined;
    return {
      url: pr.url,
      repository: pr.repository,
      number: pr.number,
      head: pr.headRefOid,
      base: pr.baseRefOid,
      review,
      coverage: {
        changedFiles: checkout.changedFiles,
        excludedFiles: checkout.excludedFiles,
        chunks: chunks.length,
      },
      ...(postedReview ? { postedReview } : {}),
    };
  } finally {
    await checkout.cleanup();
  }
}
