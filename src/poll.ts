import type { Config } from "./config.ts";
import {
  existingReview,
  isReviewRequested,
  loadPullRequest,
  type PullRequest,
} from "./github.ts";
import { reviewPullRequest } from "./review.ts";
import type { ReviewStore } from "./state.ts";

type Services = {
  load: typeof loadPullRequest;
  requested: typeof isReviewRequested;
  existing: typeof existingReview;
  review: typeof reviewPullRequest;
};

const services: Services = {
  load: loadPullRequest,
  requested: isReviewRequested,
  existing: existingReview,
  review: reviewPullRequest,
};

export type PollResult = {
  discovered: number;
  completed: number;
  skipped: number;
  failed: Array<{ url: string; error: string }>;
};

async function processRequest(
  pr: PullRequest,
  login: string,
  config: Config,
  store: ReviewStore,
  deps: Services,
): Promise<"completed" | "skipped"> {
  const previous = await deps.existing(pr);
  if (!previous && (pr.state !== "OPEN" || !(await deps.requested(pr, login))))
    return "skipped";
  const claim = store.claim(
    pr.repository,
    pr.number,
    pr.headRefOid,
    login,
    config.review.timeoutSeconds,
  );
  if (!claim) return "skipped";
  try {
    const published =
      previous ??
      (
        await deps.review(pr.url, config, true, async (observed) => {
          if (!store.isActive(claim)) throw new Error("Review claim was lost");
          if (!(await deps.requested(observed, login)))
            throw new Error("Review request was withdrawn");
        })
      ).publishedReview;
    if (!published) throw new Error("Review did not publish");
    store.complete(claim, published.id);
    return "completed";
  } catch (error) {
    store.fail(claim, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function pollRequested(
  urls: string[],
  login: string,
  config: Config,
  store: ReviewStore,
  deps: Services = services,
): Promise<PollResult> {
  if (!config.review.publish)
    throw new Error("Polling requires review.publish: true in configuration");
  const candidates = [
    ...new Set([...urls, ...store.recoverable(config.review.timeoutSeconds)]),
  ];
  const result: PollResult = {
    discovered: urls.length,
    completed: 0,
    skipped: 0,
    failed: [],
  };
  for (const url of candidates) {
    try {
      const outcome = await processRequest(
        await deps.load(url),
        login,
        config,
        store,
        deps,
      );
      result[outcome]++;
    } catch (error) {
      result.failed.push({
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
