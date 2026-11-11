import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import { z } from "zod";

const findingSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  title: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(4000),
});

const reviewSchema = z.object({
  summary: z.string().trim().min(1).max(4000),
  findings: z.array(findingSchema),
});

export type Review = z.infer<typeof reviewSchema>;

function nextQuoteState(state: number, char: string | undefined): number {
  if (state === 2) return 1;
  if (state === 1) {
    if (char === "\\") return 2;
    return char === '"' ? 0 : 1;
  }
  return char === '"' ? 1 : 0;
}

function objectEnd(response: string, start: number): number {
  let depth = 0;
  let quoteState = 0;
  for (let index = start; index < response.length; index++) {
    const char = response[index];
    const nextState = nextQuoteState(quoteState, char);
    if (quoteState !== 0 || nextState !== 0) {
      quoteState = nextState;
      continue;
    }
    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function jsonObjects(response: string): Array<{ text: string; end: number }> {
  const objects: Array<{ text: string; end: number }> = [];
  for (let start = response.indexOf("{"); start >= 0; ) {
    const end = objectEnd(response, start);
    if (end < 0) break;
    objects.push({ text: response.slice(start, end + 1), end });
    start = response.indexOf("{", end + 1);
  }
  return objects.reverse();
}

export function parseReview(response: string, maxFindings: number): Review {
  let review: Review | undefined;
  for (const candidate of jsonObjects(response)) {
    const tail = response.slice(candidate.end + 1);
    if (!/^\s*(?:```\s*)?(?:taste learning failed[^\n]*\s*)?$/.test(tail))
      continue;
    try {
      review = reviewSchema.parse(JSON.parse(candidate.text));
      break;
    } catch {
      // Progress messages and diagnostics may contain unrelated JSON.
    }
  }
  if (!review) throw new Error("Agent did not return valid review JSON");
  if (review.findings.length > maxFindings)
    throw new Error(`Agent returned more than ${maxFindings} findings`);
  for (const finding of review.findings) {
    const path = normalize(finding.file);
    if (
      isAbsolute(finding.file) ||
      path === ".." ||
      path.startsWith(`..${sep}`) ||
      path !== finding.file
    ) {
      throw new Error(`Invalid finding path: ${finding.file}`);
    }
  }
  return review;
}

export async function validateFindingLocations(
  review: Review,
  checkout: string,
): Promise<void> {
  const root = await realpath(checkout);
  for (const finding of review.findings) {
    const path = await realpath(join(root, finding.file));
    if (!path.startsWith(`${root}${sep}`))
      throw new Error(`Finding points outside checkout: ${finding.file}`);
    if (!(await stat(path)).isFile())
      throw new Error(`Finding is not a file: ${finding.file}`);
    const content = await readFile(path, "utf8");
    if (content.includes("\0"))
      throw new Error(`Finding points to a binary file: ${finding.file}`);
    const lines = content.split("\n").length - Number(content.endsWith("\n"));
    if (finding.line > lines)
      throw new Error(
        `Finding line is outside file: ${finding.file}:${finding.line}`,
      );
  }
}
