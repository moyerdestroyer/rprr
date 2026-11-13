import type { Config } from "./config.ts";
import {
  existingReview,
  isReviewRequested,
  loadPullRequest,
  type PullRequest,
  type RemoteReview,
  reviewIsCurrent,
} from "./github.ts";
import { notifyDraft } from "./notify.ts";
import { reviewPullRequest } from "./review.ts";
import type { ReviewStore } from "./state.ts";

type Services = {
  load: typeof loadPullRequest;
  requested: typeof isReviewRequested;
  existing: typeof existingReview;
  review: typeof reviewPullRequest;
  notify?: (pr: PullRequest, review: RemoteReview) => Promise<void>;
};

const services: Services = {
  load: loadPullRequest,
  requested: isReviewRequested,
  existing: existingReview,
  review: reviewPullRequest,
  notify: notifyDraft,
};

async function createDraft(
  pr: PullRequest,
  login: string,
  config: Config,
  store: ReviewStore,
  claim: { id: number; attemptId: string },
  deps: Services,
): Promise<RemoteReview | undefined> {
  const result = await deps.review(
    pr.url,
    config,
    "draft",
    async (observed) => {
      if (!store.isActive(claim)) throw new Error("Review claim was lost");
      if (!(await deps.requested(observed, login)))
        throw new Error("Review request was withdrawn");
    },
    async (observed, reviewId) => {
      store.clearDeletedDraft(observed.repository, observed.number, reviewId);
    },
  );
  return result.postedReview;
}

export type PollResult = {
  discovered: number;
  completed: number;
  skipped: number;
  failed: Array<{ url: string; error: string }>;
};

async function shouldProcess(
  pr: PullRequest,
  previous: RemoteReview | undefined,
  login: string,
  deps: Services,
): Promise<boolean> {
  if (pr.state !== "OPEN") return false;
  if (previous?.state === "COMMENTED" && previous.baseSha === undefined)
    return false;
  if (previous && reviewIsCurrent(previous, pr)) return true;
  return deps.requested(pr, login);
}

async function processRequest(
  pr: PullRequest,
  login: string,
  config: Config,
  store: ReviewStore,
  deps: Services,
): Promise<"completed" | "skipped"> {
  const previous = await deps.existing(pr, login);
  if (!(await shouldProcess(pr, previous, login, deps))) return "skipped";
  const currentReview = previous && reviewIsCurrent(previous, pr);
  const claim = store.claim(
    pr.repository,
    pr.number,
    pr.headRefOid,
    login,
    config.review.timeoutSeconds,
    pr.baseRefOid,
  );
  if (!claim) return "skipped";
  try {
    const posted =
      (currentReview ? previous : undefined) ??
      (await createDraft(pr, login, config, store, claim, deps));
    if (!posted) throw new Error("Review was not created");
    store.complete(claim, posted.id, posted.state);
    if (posted.state === "PENDING") {
      try {
        await deps.notify?.(pr, posted);
      } catch {
        // Notification failure cannot undo a GitHub draft.
      }
    }
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
