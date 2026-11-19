import { healthSnapshot } from "./health.ts";
import { serviceStatus } from "./service.ts";
import { type PollRun, type ReviewJob, ReviewStore } from "./state.ts";
import {
  mascotStatus,
  prLabel,
  prUrl,
  reviewUrl,
  terminalText,
  wrapText,
} from "./terminal.ts";

type Health = Awaited<ReturnType<typeof healthSnapshot>>;
type Service = Awaited<ReturnType<typeof serviceStatus>>;

function timerFailed(service: Service): boolean {
  return (
    service.installed &&
    service.lastResult !== "" &&
    service.lastResult !== "success"
  );
}

function needsAttention(job: ReviewJob): boolean {
  return job.status === "failed" || job.status === "blocked";
}

function ago(value: string): string {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(value)) / 1000),
  );
  if (!Number.isFinite(seconds)) return "unknown time";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function timerLabel(service: Service): string {
  if (!service.installed) return "not installed (manual polling)";
  if (service.active === "active") return "on (every 15 minutes)";
  if (service.enabled === "disabled") return "off";
  if (service.active === "failed") return "failed; run rprr service status";
  return "inactive or unavailable; run rprr service status";
}

function statusLines(
  jobs: ReviewJob[],
  draftCount: number,
  lastPoll: PollRun | undefined,
  health: Health,
  service: Service,
): string[] {
  const failures = jobs.filter(needsAttention).length;
  const running = jobs.filter((job) => job.status === "running").length;
  const unhealthy = Object.values(health).some((value) => !value);
  const attention =
    unhealthy ||
    failures > 0 ||
    lastPoll?.status === "failed" ||
    timerFailed(service) ||
    (service.installed &&
      service.enabled.startsWith("enabled") &&
      service.active !== "active");
  const headline = attention
    ? "Needs attention"
    : running || lastPoll?.status === "running"
      ? "Reviewing"
      : "Ready";
  const lines = [
    `RPRR / ${headline}`,
    "",
    `${draftCount} draft${draftCount === 1 ? "" : "s"} ready / ${running} reviewing / ${failures} ${failures === 1 ? "needs" : "need"} attention`,
    lastPoll
      ? `Last poll: ${ago(lastPoll.finished_at ?? lastPoll.started_at)} (${lastPoll.status})`
      : "Last poll: not run yet",
    `Timer: ${timerLabel(service)}`,
    "",
    "Drafts: rprr drafts",
  ];
  if (failures || lastPoll?.status === "failed")
    lines.push("Failures: rprr status --failures");
  if (unhealthy) lines.push("Health: rprr doctor");
  if (timerFailed(service)) lines.push("Timer failed: rprr service status");
  return lines;
}

function printFailures(jobs: ReviewJob[], lastPoll: PollRun | undefined): void {
  if (lastPoll?.error) {
    console.log("Last poll failed\n");
    console.log(wrapText(lastPoll.error, 76).join("\n"));
    console.log("\nCheck `rprr doctor`, then retry with `rprr poll`.\n");
  }
  const failures = jobs.filter(needsAttention);
  if (!failures.length) {
    console.log("No failed PRs in the latest locally tracked reviews.");
    return;
  }
  console.log(
    `${failures.length} PR${failures.length === 1 ? " needs" : "s need"} attention\n`,
  );
  for (const job of failures) {
    const reason =
      terminalText(job.error ?? "No error recorded").split("\n")[0] ?? "";
    console.log(`${prLabel(job)} / ${job.status}`);
    console.log(
      `  ${reason.length > 100 ? `${reason.slice(0, 97)}...` : reason}`,
    );
    console.log(`  Inspect: rprr status ${terminalText(prUrl(job))}\n`);
  }
}

function inspectJob(selector: string, jobs: ReviewJob[]): void {
  const match =
    /^(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/|([\w.-]+\/[\w.-]+)#)([1-9]\d*)$/.exec(
      selector,
    );
  if (!match)
    throw new Error("status requires a GitHub PR URL or OWNER/REPO#NUMBER");
  const repository = match[1] ?? match[2];
  const job = jobs.find(
    (job) =>
      job.repository.toLowerCase() === repository?.toLowerCase() &&
      job.pr_number === Number(match[3]),
  );
  if (!job) throw new Error(`No locally tracked review for ${selector}`);
  console.log(`${prLabel(job)} / ${job.status}\n`);
  console.log(terminalText(prUrl(job)));
  console.log(`Head: ${terminalText(job.head_sha)}`);
  console.log(
    `Updated: ${terminalText(job.completed_at ?? job.started_at ?? "unknown")}`,
  );
  if (job.review_state === "PENDING")
    console.log(`Draft: ${terminalText(reviewUrl(job))}`);
  if (job.error) console.log(`\n${wrapText(job.error, 76).join("\n")}`);
  if (needsAttention(job)) {
    if (job.status === "blocked")
      console.log(
        "\nAutomatic retry waits for changed inputs. Adjust review limits or exclusions if needed.",
      );
    console.log(`\nRetry: rprr review ${terminalText(prUrl(job))}`);
  }
}

export async function statusCommand(args: string[]): Promise<void> {
  if (
    args.length > 1 ||
    (args[0]?.startsWith("-") && !["--json", "--failures"].includes(args[0]))
  )
    throw new Error(
      "status accepts --json, --failures, or one PR URL or OWNER/REPO#NUMBER",
    );
  const store = await ReviewStore.open();
  try {
    const lastPoll = store.latestPoll();
    if (args[0] === "--json") {
      const [health, service] = await Promise.all([
        healthSnapshot(),
        serviceStatus(),
      ]);
      console.log(
        JSON.stringify(
          { lastPoll, jobs: store.recent(), health, service },
          null,
          2,
        ),
      );
      return;
    }
    const jobs = store.currentJobs();
    if (args[0] === "--failures") {
      printFailures(jobs, lastPoll);
      return;
    }
    if (args[0]) {
      inspectJob(args[0], jobs);
      return;
    }
    const [health, service] = await Promise.all([
      healthSnapshot(),
      serviceStatus(),
    ]);
    console.log(
      mascotStatus(
        statusLines(jobs, store.drafts().length, lastPoll, health, service),
        process.stdout.columns || 100,
      ),
    );
  } finally {
    store.close();
  }
}
