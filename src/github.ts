import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const prSchema = z.object({
  url: z.string().url(),
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  body: z.string().nullable(),
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/),
  baseRefOid: z.string().regex(/^[0-9a-f]{40}$/),
});

export type PullRequest = z.infer<typeof prSchema> & { repository: string };
export const reviewMarker = "RPRR review (non-approving)";
export type RemoteReview = {
  id: number;
  url: string;
  state: "PENDING" | "COMMENTED";
  baseSha?: string;
};

export function reviewIsCurrent(
  review: RemoteReview,
  pr: PullRequest,
): boolean {
  return review.baseSha === pr.baseRefOid;
}

const searchResultSchema = z.array(z.object({ url: z.string().url() }));
const requestedSchema = z.object({
  users: z.array(z.object({ login: z.string() })),
});
const remoteReviewsSchema = z.array(
  z.array(
    z.object({
      id: z.number().int().positive(),
      state: z.string(),
      body: z.string().nullable(),
      commit_id: z.string(),
      html_url: z.string().url(),
      user: z.object({ login: z.string() }),
    }),
  ),
);

async function run(command: string[], cwd?: string): Promise<string> {
  const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => process.kill(), 120_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (exitCode !== 0)
      throw new Error(
        `${command[0]} failed: ${stderr.trim() || stdout.trim()}`,
      );
    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}

export async function loadPullRequest(selector: string): Promise<PullRequest> {
  if (
    !/^[1-9]\d*$/.test(selector) &&
    !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*$/.test(selector)
  ) {
    throw new Error("PR must be a positive number or GitHub pull request URL");
  }
  const raw = await run([
    "gh",
    "pr",
    "view",
    selector,
    "--json",
    "url,number,title,state,body,headRefOid,baseRefOid",
  ]);
  const pr = prSchema.parse(JSON.parse(raw));
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+$/.exec(
    pr.url,
  );
  if (!match?.[1]) throw new Error(`Unsupported pull request URL: ${pr.url}`);
  return { ...pr, repository: match[1] };
}

export async function requestedPullRequests(): Promise<string[]> {
  const raw = await run([
    "gh",
    "search",
    "prs",
    "user-review-requested:@me",
    "--state",
    "open",
    "--json",
    "url",
    "--limit",
    "1000",
  ]);
  const results = searchResultSchema.parse(JSON.parse(raw));
  if (results.length === 1000)
    throw new Error("Review request search reached GitHub's 1000-result limit");
  return [...new Set(results.map((result) => result.url))];
}

export async function currentLogin(): Promise<string> {
  const raw = await run(["gh", "api", "user", "--jq", ".login"]);
  const login = raw.trim();
  if (!/^[A-Za-z0-9-]+$/.test(login))
    throw new Error("Could not determine GitHub login");
  return login;
}

export async function isReviewRequested(
  pr: PullRequest,
  login: string,
): Promise<boolean> {
  const endpoint = `repos/${pr.repository}/pulls/${pr.number}/requested_reviewers`;
  const response = requestedSchema.parse(
    JSON.parse(await run(["gh", "api", endpoint])),
  );
  return response.users.some(
    (user) => user.login.toLowerCase() === login.toLowerCase(),
  );
}

export async function existingReview(
  pr: PullRequest,
  login?: string,
): Promise<RemoteReview | undefined> {
  const reviewer = login ?? (await currentLogin());
  const endpoint = `repos/${pr.repository}/pulls/${pr.number}/reviews`;
  const pages = remoteReviewsSchema.parse(
    JSON.parse(await run(["gh", "api", endpoint, "--paginate", "--slurp"])),
  );
  const matches = pages
    .flat()
    .filter(
      (review) =>
        (review.state === "PENDING" || review.state === "COMMENTED") &&
        review.user.login.toLowerCase() === reviewer.toLowerCase() &&
        review.commit_id === pr.headRefOid &&
        review.body?.startsWith(reviewMarker),
    )
    .map((review) => ({
      ...review,
      baseSha:
        /^RPRR review \(non-approving\)\n<!-- rprr-base:([0-9a-f]{40}) -->\n/.exec(
          review.body ?? "",
        )?.[1],
    }));
  const match =
    matches.find(
      (review) =>
        review.state === "PENDING" && review.baseSha === pr.baseRefOid,
    ) ??
    matches.find(
      (review) =>
        review.state === "COMMENTED" && review.baseSha === pr.baseRefOid,
    ) ??
    matches.find((review) => review.state === "PENDING") ??
    matches[0];
  return match
    ? {
        id: match.id,
        url: match.html_url,
        state: match.state as RemoteReview["state"],
        ...(match.baseSha ? { baseSha: match.baseSha } : {}),
      }
    : undefined;
}

export async function checkoutPullRequest(
  pr: PullRequest,
): Promise<{ path: string; diff: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "rprr-review-"));
  const path = join(root, "repo");
  try {
    await run([
      "gh",
      "repo",
      "clone",
      pr.repository,
      path,
      "--",
      "--filter=blob:none",
    ]);
    await run(
      [
        "gh",
        "pr",
        "checkout",
        String(pr.number),
        "--detach",
        "--repo",
        pr.repository,
      ],
      path,
    );
    const head = await run(["git", "rev-parse", "HEAD"], path);
    if (head !== pr.headRefOid)
      throw new Error("PR head changed during checkout; retry review");
    await run(["git", "fetch", "origin", pr.baseRefOid], path);
    const base = await run(["git", "rev-parse", "FETCH_HEAD"], path);
    if (base !== pr.baseRefOid)
      throw new Error("PR base changed during checkout; retry review");
    const diff = await run(
      [
        "git",
        "diff",
        "--no-ext-diff",
        "--unified=3",
        `${base}...${head}`,
        "--",
      ],
      path,
    );
    if (Buffer.byteLength(diff, "utf8") > 500_000)
      throw new Error("PR diff exceeds the 500 KB review limit");
    return {
      path,
      diff,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function restoreCheckout(
  path: string,
  head: string,
): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("Invalid PR head");
  await run(["git", "reset", "--hard", head], path);
  await run(["git", "clean", "-ffdx"], path);
  if ((await run(["git", "rev-parse", "HEAD"], path)) !== head)
    throw new Error("PR checkout head changed during review");
}
