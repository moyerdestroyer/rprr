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
} from "./github.ts";
import { composeReviewPrompt, reviewInstructions } from "./prompt.ts";
import { publishReview } from "./publish.ts";

export async function reviewPullRequest(
  selector: string,
  config: Config,
  publish = false,
  beforePublish?: (pr: PullRequest) => Promise<void>,
): Promise<{
  url: string;
  head: string;
  review: Review;
  publishedReview?: { id: number; url: string };
}> {
  if (publish && !config.review.publish)
    throw new Error("Review publication is disabled in configuration");
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
    const review = parseReview(output, config.review.maxFindings);
    await validateFindingLocations(review, checkout.path);
    if (publish) await beforePublish?.(pr);
    const publishedReview = publish
      ? await publishReview(pr, review, checkout.diff)
      : undefined;
    return {
      url: pr.url,
      head: pr.headRefOid,
      review,
      ...(publishedReview ? { publishedReview } : {}),
    };
  } finally {
    await checkout.cleanup();
  }
}
