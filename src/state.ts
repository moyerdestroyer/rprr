import { Database } from "bun:sqlite";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { appPaths } from "./config.ts";

export async function initializeState(path = appPaths().state): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY,
        repository TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        request_identity TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
        started_at TEXT,
        completed_at TEXT,
        published_review_id INTEGER,
        error TEXT,
        UNIQUE (repository, pr_number, head_sha)
      );
    `);
  } finally {
    db.close();
  }
  await chmod(path, 0o600);
}
