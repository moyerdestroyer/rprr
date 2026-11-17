import { expect, test } from "bun:test";
import { DiffCollector } from "../src/diff-collect.ts";

const small =
  "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
const large = `diff --git a/big.js b/big.js\n+${"x".repeat(400)}\n`;

test("a streamed diff keeps small files and names files over the cap", () => {
  const collector = new DiffCollector(200);
  const text = small + large + small.replaceAll("a.ts", "c.ts");
  for (let index = 0; index < text.length; index += 7)
    collector.push(text.slice(index, index + 7));
  const result = collector.finish();
  expect(result.omittedFiles).toEqual(["big.js"]);
  expect(result.diff).toBe(small + small.replaceAll("a.ts", "c.ts"));
  expect(result.diff.includes("x".repeat(50))).toBe(false);
});
