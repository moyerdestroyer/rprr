import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/acp.ts";
import { ProcessOutputLimitError, runCommand } from "../src/process.ts";

test("commands preserve output and report exit status and stderr", async () => {
  expect(await runCommand(["sh", "-c", "printf 'hello\\n'"])).toBe("hello\n");
  await expect(
    runCommand(["sh", "-c", "echo broken >&2; exit 7"]),
  ).rejects.toThrow("exit 7): broken");
  await expect(runCommand(["/does-not-exist-rprr"])).rejects.toThrow();
});

test("timeouts terminate descendants holding pipes and prevent later writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "rprr-timeout-"));
  const marker = join(root, "leaked");
  try {
    const started = Date.now();
    await expect(
      runCommand(
        [
          "sh",
          "-c",
          'sh -c \'sleep 0.6; echo leaked > "$1"\' child "$1" & wait',
          "parent",
          marker,
        ],
        root,
        100,
      ),
    ).rejects.toThrow("timed out after 0.1s");
    expect(Date.now() - started).toBeLessThan(550);
    await Bun.sleep(700);
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stdout over the byte limit fails and stops the command", async () => {
  const started = Date.now();
  await expect(
    runCommand(
      ["sh", "-c", "printf 'abcdefghij'; sleep 30"],
      undefined,
      5_000,
      4,
    ),
  ).rejects.toBeInstanceOf(ProcessOutputLimitError);
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(
    await runCommand(["sh", "-c", "printf abcd"], undefined, 5_000, 4),
  ).toBe("abcd");
});

test("ACP timeouts remain explicit even when the agent writes stderr", async () => {
  await expect(
    runAgent(
      { command: "sh", args: ["-c", "echo progress >&2; sleep 30"] },
      tmpdir(),
      "Review",
      0.1,
    ),
  ).rejects.toThrow("ACP agent timed out after 0.1s");
});
