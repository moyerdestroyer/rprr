import { runAgent } from "./acp.ts";
import type { Config } from "./config.ts";
import {
  parseReview,
  type Review,
  validateFindingLocations,
} from "./findings.ts";
import {
  checkoutPullRequest,
  loadPullRequest,
  type PullRequest,
  type RemoteReview,
  restoreCheckout,
} from "./github.ts";
import { composeReviewPrompt, reviewInstructions } from "./prompt.ts";
import { postReview } from "./publish.ts";

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
  postedReview?: RemoteReview;
}> {
  const pr = await loadPullRequest(selector);
  const checkout = await checkoutPullRequest(pr);
  try {
    const context = JSON.stringify({
      url: pr.url,
      title: pr.title,
      description: pr.body ?? "",
      head: pr.headRefOid,
      diff: checkout.diff,
    });
    const instructions = await reviewInstructions(config);
    const output = await runAgent(
      config.agent,
      checkout.path,
      composeReviewPrompt(instructions.text, context),
      config.review.timeoutSeconds,
      config.review.skill,
    );
    await restoreCheckout(checkout.path, pr.headRefOid);
    const review = parseReview(output, config.review.maxFindings);
    await validateFindingLocations(review, checkout.path);
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
      ...(postedReview ? { postedReview } : {}),
    };
  } finally {
    await checkout.cleanup();
  }
}
