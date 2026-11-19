import { expect, test } from "bun:test";
import mascot from "../assets/mascot.txt" with { type: "text" };
import { mascotStatus, terminalText, wrapText } from "../src/terminal.ts";

test("wide terminals keep the summary visible at the bottom of the mascot", () => {
  const output = mascotStatus(["RPRR / Ready", "", "2 drafts ready"], 160);
  const rows = output.split("\n");
  expect(rows.at(-3)).toContain("RPRR / Ready");
  expect(rows.at(-1)).toContain("2 drafts ready");
  expect(rows).toHaveLength(mascot.trimEnd().split("\n").length);
  expect(output).not.toContain("\u001b");
});

test("narrow terminals stack the mascot and wrap summary text", () => {
  const output = mascotStatus(
    [
      "RPRR / Needs attention",
      "12 drafts ready / 2 reviewing / 3 need attention",
    ],
    40,
  );
  expect(output).toContain(`${mascot.trimEnd()}\n\nRPRR / Needs attention`);
  const summary = output.slice(mascot.trimEnd().length + 2);
  expect(summary.split("\n").every((line) => line.length <= 40)).toBe(true);
  expect(wrapText("longwordwithoutspaces", 8)).toEqual([
    "longword",
    "withouts",
    "paces",
  ]);
  expect(wrapText("first line\n\nsecond line", 40)).toEqual([
    "first line",
    "",
    "second line",
  ]);
});

test("standard terminals preserve the wide artwork above the summary", () => {
  const rows = mascotStatus(
    ["RPRR / Ready", "", "12 drafts ready / 2 reviewing / 3 need attention"],
    80,
  ).split("\n");
  const art = mascot.trimEnd().split("\n");
  expect(rows.slice(0, art.length)).toEqual(art);
  expect(rows[art.length + 1]).toBe("RPRR / Ready");
  expect(rows.every((line) => line.length <= 80)).toBe(true);
  expect(rows.join("\n")).toContain("attention");
});

test("agent error text cannot control the terminal", () => {
  expect(terminalText("\u001b[31merror\u001b[0m\u0007\r\nsecond\u009b")).toBe(
    "error\nsecond",
  );
  expect(
    terminalText("\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007"),
  ).toBe("link");
});
