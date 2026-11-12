import { expect, test } from "bun:test";
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

test("interview accepts the Command Code preset and keeps publishing off", async () => {
  const { ask, prompts } = scripted(["", ""]);
  const choices = await interviewSetup(ask, {
    commandCode: true,
    timer: true,
  });
  expect(choices).toEqual({
    command: "cmd",
    args: ["--no-session", "--no-auto-update", "acp"],
    publish: false,
    enableTimer: false,
  });
  expect(prompts).toEqual([
    "Use cmd with --no-session --no-auto-update acp? [Y/n] ",
    "Post COMMENT reviews for direct review requests? [y/N] ",
  ]);
});

test("interview can choose a custom agent and enable the timer", async () => {
  const { ask, prompts } = scripted(["n", "agent", "--one two", "yes", "y"]);
  const choices = await interviewSetup(ask, {
    commandCode: true,
    timer: true,
  });
  expect(choices).toEqual({
    command: "agent",
    args: ["--one", "two"],
    publish: true,
    enableTimer: true,
  });
  expect(prompts).toHaveLength(5);
});

test("interview skips the timer when publication or systemd is unavailable", async () => {
  const flagged = scripted(["custom", ""]);
  expect(
    await interviewSetup(flagged.ask, {
      commandCode: false,
      timer: true,
      publish: false,
    }),
  ).toMatchObject({ publish: false, enableTimer: false });
  expect(flagged.prompts.some((prompt) => prompt.includes("15 minutes"))).toBe(
    false,
  );
  const withoutTimer = scripted(["custom", "", "yes"]);
  expect(
    await interviewSetup(withoutTimer.ask, {
      commandCode: false,
      timer: false,
    }),
  ).toMatchObject({ publish: true, enableTimer: false });
  expect(
    withoutTimer.prompts.some((prompt) => prompt.includes("15 minutes")),
  ).toBe(false);
});

test("interview rejects an empty agent and an unclear answer", async () => {
  const empty = scripted([""]);
  await expect(
    interviewSetup(empty.ask, { commandCode: false, timer: false }),
  ).rejects.toThrow(/executable is required/);
  const unclear = scripted(["cmd", "", "maybe"]);
  await expect(
    interviewSetup(unclear.ask, { commandCode: false, timer: false }),
  ).rejects.toThrow(/yes or no/);
});
