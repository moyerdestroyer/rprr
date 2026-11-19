import { ReviewStore } from "./state.ts";
import { prLabel, prUrl, reviewUrl, terminalText } from "./terminal.ts";

export async function draftsCommand(args: string[]): Promise<void> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--json"))
    throw new Error("drafts accepts only --json");
  const store = await ReviewStore.open();
  try {
    const jobs = store.drafts();
    if (args[0] === "--json") {
      console.log(
        JSON.stringify(
          jobs.map((job) => ({
            url: prUrl(job),
            reviewUrl: reviewUrl(job),
            reviewId: job.review_id,
            head: job.head_sha,
          })),
          null,
          2,
        ),
      );
      return;
    }
    if (!jobs.length) {
      console.log(
        "No locally tracked drafts.\n\nRun `rprr poll` to check for review requests.",
      );
      return;
    }
    console.log(
      `${jobs.length} draft${jobs.length === 1 ? "" : "s"} to review\n`,
    );
    jobs.forEach((job, index) => {
      console.log(`${index + 1}. ${prLabel(job)}`);
      console.log(`   ${terminalText(reviewUrl(job))}\n`);
    });
    console.log("Open a link to review and submit your draft on GitHub.");
    console.log("Or submit from the CLI: rprr review <PR-URL> --publish");
    console.log(
      "Drafts are tracked locally; changes made on GitHub may not appear here.",
    );
  } finally {
    store.close();
  }
}
