import type { Config } from "./config.ts";
import type { Review } from "./findings.ts";
import {
  checkoutPullRequest,
  loadPullRequest,
  type PullRequest,
  type RemoteReview,
} from "./github.ts";
import { reviewInstructions } from "./prompt.ts";
import { postReview } from "./publish.ts";
import { reviewChunks } from "./review-chunks.ts";
import { planReview } from "./review-plan.ts";

async function checkoutForReview(pr: PullRequest, config: Config) {
  return checkoutPullRequest(
    pr,
    config.review.excludePaths,
    config.review.maxDiffBytes ?? 500_000,
    config.review.timeoutSeconds * 1000,
  );
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
  coverage: {
    changedFiles: string[];
    excludedFiles: string[];
    omittedFiles: string[];
    chunks: number;
  };
  postedReview?: RemoteReview;
}> {
  const pr = await loadPullRequest(selector);
  const checkout = await checkoutForReview(pr, config);
  try {
    const plan = planReview(checkout.diff, config.review);
    const omittedFiles = [...checkout.omittedFiles, ...plan.omittedFiles];
    const instructions = await reviewInstructions(config);
    const review = await reviewChunks(
      pr,
      { ...checkout, omittedFiles },
      plan.chunks,
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
        omittedFiles,
        chunks: plan.chunks.length,
      },
      ...(postedReview ? { postedReview } : {}),
    };
  } finally {
    await checkout.cleanup();
  }
}
