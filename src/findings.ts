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

function jsonText(response: string): string {
  const trimmed = response.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

export function parseReview(response: string, maxFindings: number): Review {
  const review = reviewSchema.parse(JSON.parse(jsonText(response)));
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
