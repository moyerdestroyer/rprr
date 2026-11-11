import type { Review } from "./findings.ts";

function hunkLine(line: string): number {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!match?.[1]) throw new Error("Unsupported PR diff hunk");
  return Number(match[1]);
}

function recordLine(line: string, lineNumber: number, added: Set<number>) {
  if (line.startsWith("+")) {
    added.add(lineNumber);
    return lineNumber + 1;
  }
  return line.startsWith(" ") ? lineNumber + 1 : lineNumber;
}

function filePath(
  line: string,
  files: Map<string, Set<number>>,
): string | undefined {
  const target = line.slice(4);
  const path = target.startsWith("b/") ? target.slice(2) : undefined;
  if (path) files.set(path, new Set());
  return path;
}

export function addedLines(diff: string): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>();
  let path: string | undefined;
  let lineNumber = 0;
  let added: Set<number> | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      path = undefined;
      added = undefined;
      continue;
    }
    if (!added && line.startsWith("+++ ")) {
      path = filePath(line, files);
      continue;
    }
    if (line.startsWith("@@ ")) {
      if (!path) throw new Error("Unsupported PR diff hunk");
      lineNumber = hunkLine(line);
      added = files.get(path);
      continue;
    }
    if (added) lineNumber = recordLine(line, lineNumber, added);
  }
  return files;
}

export function validateInlineLocations(review: Review, diff: string): void {
  const files = addedLines(diff);
  for (const finding of review.findings) {
    if (!files.get(finding.file)?.has(finding.line))
      throw new Error(
        `Finding is not on an added PR line: ${finding.file}:${finding.line}`,
      );
  }
}
