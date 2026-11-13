import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("checkout diff excludes unrelated base branch changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "rprr-diff-test-"));
  const source = join(root, "source");
  const bin = join(root, "bin");
  const script = join(bin, "gh");
  await Bun.$`mkdir -p ${source} ${bin}`.quiet();
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: source });
    if (result.exitCode !== 0)
      throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  try {
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    await writeFile(join(source, "feature.txt"), "original\n");
    git(["add", "."]);
    git(["commit", "-qm", "initial"]);
    git(["checkout", "-qb", "feature"]);
    await writeFile(join(source, "feature.txt"), "feature\n");
    git(["commit", "-qam", "feature"]);
    const head = git(["rev-parse", "HEAD"]);
    git(["checkout", "-q", "main"]);
    await writeFile(join(source, "base.txt"), "unrelated base change\n");
    git(["add", "."]);
    git(["commit", "-qm", "base advanced"]);
    const base = git(["rev-parse", "HEAD"]);
    await writeFile(
      script,
      `#!/bin/sh
if [ "$1" = repo ]; then
  git clone -q "$RPRR_SOURCE" "$4"
elif [ "$1" = pr ]; then
  git checkout -q --detach "$RPRR_HEAD"
else
  exit 1
fi
`,
    );
    await chmod(script, 0o755);
    const pr = {
      url: "https://github.com/org/repo/pull/1",
      repository: "org/repo",
      number: 1,
      title: "Feature",
      state: "OPEN",
      body: null,
      headRefOid: head,
      baseRefOid: base,
    };
    const modulePath = join(import.meta.dir, "../src/github.ts");
    const code = `import { checkoutPullRequest } from ${JSON.stringify(modulePath)}; const checkout = await checkoutPullRequest(${JSON.stringify(pr)}); console.log(JSON.stringify(checkout.diff)); await checkout.cleanup();`;
    const child = Bun.spawn([process.execPath, "-e", code], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RPRR_SOURCE: source,
        RPRR_HEAD: head,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const diff = JSON.parse(stdout) as string;
    expect(diff).toContain("+feature");
    expect(diff).not.toContain("base.txt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
