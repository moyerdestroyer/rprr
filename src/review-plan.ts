import { createHash } from "node:crypto";
import type { Config } from "./config.ts";
import { diffDestination } from "./diff-collect.ts";

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

type PlannedFile = { path: string; bytes: number; pieces: string[] };

function filePieces(file: string, maxBytes: number): string[] | undefined {
  if (Buffer.byteLength(file) <= maxBytes) return [file];
  const [header = "", ...hunks] = file.split(/(?=^@@ )/m);
  const pieces = hunks.map((hunk) => header + hunk);
  if (
    !pieces.length ||
    pieces.some((piece) => Buffer.byteLength(piece) > maxBytes)
  )
    return undefined;
  return pieces;
}

function packPieces(
  files: PlannedFile[],
  maxBytes: number,
  maxChunks: number,
): string[] | undefined {
  const chunks: string[] = [];
  let current = "";
  for (const file of files) {
    for (const piece of file.pieces) {
      if (
        current &&
        Buffer.byteLength(current) + Buffer.byteLength(piece) > maxBytes
      ) {
        chunks.push(current);
        current = "";
      }
      if (chunks.length >= maxChunks) return undefined;
      current += piece;
    }
  }
  if (current) {
    if (chunks.length >= maxChunks) return undefined;
    chunks.push(current);
  }
  return chunks;
}

function dropLargest(files: PlannedFile[]): PlannedFile[] {
  let largest = 0;
  for (let index = 1; index < files.length; index++) {
    const candidate = files[index];
    const current = files[largest];
    if (candidate && current && candidate.bytes >= current.bytes)
      largest = index;
  }
  return files.filter((_, index) => index !== largest);
}

export type ReviewPlan = { chunks: string[]; omittedFiles: string[] };

export function planReview(diff: string, config: Config["review"]): ReviewPlan {
  const { maxDiffBytes, maxChunks } = reviewBudget(config);
  const omittedFiles: string[] = [];
  let kept: PlannedFile[] = [];
  for (const file of diff.split(/(?=^diff --git )/m).filter(Boolean)) {
    const path = diffDestination(file.split("\n")[0] ?? "") ?? "unknown";
    const pieces = filePieces(file, maxDiffBytes);
    if (!pieces) omittedFiles.push(path);
    else kept.push({ path, bytes: Buffer.byteLength(file), pieces });
  }
  while (kept.length) {
    const chunks = packPieces(kept, maxDiffBytes, maxChunks);
    if (chunks) return { chunks, omittedFiles };
    const next = dropLargest(kept);
    const removed = kept.find((file) => !next.includes(file));
    if (removed) omittedFiles.push(removed.path);
    kept = next;
  }
  return { chunks: [], omittedFiles };
}
