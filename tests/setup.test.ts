import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAgentCommand } from "../src/agent-command.ts";
import { interviewSetup } from "../src/setup.ts";

function scripted(answers: string[]) {
  const prompts: string[] = [];
  const ask = async (prompt: string) => {
    prompts.push(prompt);
    const next = answers.shift();
    if (next === undefined) throw new Error(`No answer for ${prompt}`);
    return next;
  };
  return { ask, prompts };
}

test("interview accepts any ACP executable and leaves the timer off", async () => {
  const { ask, prompts } = scripted(["other-agent", "acp --stdio", ""]);
  const choices = await interviewSetup(ask, { timer: true });
  expect(choices).toEqual({
    command: "other-agent",
    args: ["acp", "--stdio"],
    enableTimer: false,
  });
  expect(prompts).toEqual([
    "ACP agent executable or path: ",
    "ACP arguments, separated by spaces (blank for none): ",
    "Check for review requests every 15 minutes? [y/N] ",
  ]);
});

test("interview can choose a custom agent and enable the timer", async () => {
  const { ask, prompts } = scripted(["agent", "--one two", "y"]);
  const choices = await interviewSetup(ask, { timer: true });
  expect(choices).toEqual({
    command: "agent",
    args: ["--one", "two"],
    enableTimer: true,
  });
  expect(prompts).toHaveLength(3);
});

test("interview skips the timer when systemd is unavailable", async () => {
  const withoutTimer = scripted(["custom", ""]);
  expect(
    await interviewSetup(withoutTimer.ask, {
      timer: false,
    }),
  ).toMatchObject({ enableTimer: false });
  expect(
    withoutTimer.prompts.some((prompt) => prompt.includes("15 minutes")),
  ).toBe(false);
});

test("interview rejects an empty agent and an unclear answer", async () => {
  const empty = scripted([""]);
  await expect(interviewSetup(empty.ask, { timer: false })).rejects.toThrow(
    /executable is required/,
  );
  const unclear = scripted(["other-agent", "", "maybe"]);
  await expect(interviewSetup(unclear.ask, { timer: true })).rejects.toThrow(
    /yes or no/,
  );
});

test("agent command resolution accepts executable paths and reports missing paths", () => {
  expect(resolveAgentCommand("/bin/sh")).toBe("/bin/sh");
  expect(resolveAgentCommand("~/missing-acp-agent")).toBeUndefined();
  expect(
    resolveAgentCommand(join(homedir(), "missing-acp-agent")),
  ).toBeUndefined();
});
