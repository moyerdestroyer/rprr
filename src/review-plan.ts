import { createHash } from "node:crypto";
import type { Config } from "./config.ts";

export class ReviewLimitError extends Error {}

function reviewBudget(config: Config["review"]) {
  return {
    maxDiffBytes: config.maxDiffBytes ?? 500_000,
    maxChunks: config.maxChunks ?? 20,
    excludePaths: config.excludePaths ?? [],
  };
}

export function reviewBudgetKey(config: Config["review"]): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, ...reviewBudget(config) }))
    .digest("hex");
}

export function reviewByteBudget(config: Config["review"]): number {
  const { maxDiffBytes, maxChunks } = reviewBudget(config);
  return maxDiffBytes * maxChunks;
}

function filePieces(file: string, maxBytes: number): string[] {
  if (Buffer.byteLength(file) <= maxBytes) return [file];
  const [header = "", ...hunks] = file.split(/(?=^@@ )/m);
  const pieces = hunks.map((hunk) => header + hunk);
  if (
    !pieces.length ||
    pieces.some((piece) => Buffer.byteLength(piece) > maxBytes)
  )
    throw new ReviewLimitError(
      `A diff hunk or file header exceeds review.maxDiffBytes (${maxBytes} bytes): ${file.split("\n")[0]?.slice(0, 200)}. Increase the budget or configure review.excludePaths; no review was posted.`,
    );
  return pieces;
}

export function planReview(diff: string, config: Config["review"]): string[] {
  const { maxDiffBytes, maxChunks } = reviewBudget(config);
  const chunks: string[] = [];
  let current = "";
  for (const file of diff.split(/(?=^diff --git )/m).filter(Boolean)) {
    for (const piece of filePieces(file, maxDiffBytes)) {
      if (
        current &&
        Buffer.byteLength(current) + Buffer.byteLength(piece) > maxDiffBytes
      ) {
        chunks.push(current);
        current = "";
      }
      current += piece;
      if (chunks.length >= maxChunks)
        throw new ReviewLimitError(
          `PR diff requires more than review.maxChunks (${maxChunks}) at ${maxDiffBytes} bytes per chunk. Increase the budget or configure review.excludePaths; no review was posted.`,
        );
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
