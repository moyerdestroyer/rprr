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
      ["git", "diff", "--no-ext-diff", "--unified=3", base, head, "--"],
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
