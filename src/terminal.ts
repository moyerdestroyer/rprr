import mascot from "../assets/mascot.txt" with { type: "text" };
import type { ReviewJob } from "./state.ts";

// Errors can contain agent output. Keep terminal control sequences out of views.
export function terminalText(value: string): string {
  return Array.from(Bun.stripANSI(value))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return character === "\n" || (code >= 32 && (code < 127 || code > 159));
    })
    .join("");
}

export function prUrl(job: ReviewJob): string {
  return `https://github.com/${job.repository}/pull/${job.pr_number}`;
}

export function prLabel(job: ReviewJob): string {
  return terminalText(`${job.repository}#${job.pr_number}`);
}

export function reviewUrl(job: ReviewJob): string {
  return `${prUrl(job)}#pullrequestreview-${job.review_id}`;
}

export function wrapText(value: string, width: number): string[] {
  return terminalText(value)
    .split("\n")
    .flatMap((line) => {
      const result: string[] = [];
      let remaining = line;
      while (remaining.length > width) {
        const space = remaining.lastIndexOf(" ", width);
        const split = space > 0 ? space : width;
        result.push(remaining.slice(0, split));
        remaining = remaining.slice(split).trimStart();
      }
      return [...result, remaining];
    });
}

export function mascotStatus(lines: string[], columns: number): string {
  const art = mascot.trimEnd().split("\n");
  const artWidth = Math.max(...art.map((line) => line.length));
  const contentWidth = columns - artWidth - 4;
  if (contentWidth < 32)
    return `${mascot.trimEnd()}\n\n${lines.flatMap((line) => wrapText(line, Math.max(20, columns))).join("\n")}`;
  const content = lines.flatMap((line) => wrapText(line, contentWidth));
  // Keep the status visible at the prompt when the artwork exceeds a screen.
  const contentOffset = Math.max(0, art.length - content.length);
  return Array.from({ length: Math.max(art.length, content.length) }, (_, i) =>
    `${(art[i] ?? "").padEnd(artWidth)}    ${content[i - contentOffset] ?? ""}`.trimEnd(),
  ).join("\n");
}
