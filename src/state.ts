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
        attempt_id TEXT,
        UNIQUE (repository, pr_number, head_sha)
      );
    `);
    const columns = db.query("PRAGMA table_info(reviews)").all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === "attempt_id"))
      db.exec("ALTER TABLE reviews ADD COLUMN attempt_id TEXT");
  } finally {
    db.close();
  }
  await chmod(path, 0o600);
}

export type ReviewJob = {
  id: number;
  repository: string;
  pr_number: number;
  head_sha: string;
  status: "pending" | "running" | "completed" | "failed";
  started_at: string | null;
  completed_at: string | null;
  published_review_id: number | null;
  error: string | null;
};

export class ReviewStore {
  private constructor(private readonly db: Database) {}

  static async open(path = appPaths().state): Promise<ReviewStore> {
    await initializeState(path);
    const db = new Database(path);
    db.exec("PRAGMA busy_timeout = 5000");
    return new ReviewStore(db);
  }

  claim(
    repository: string,
    number: number,
    head: string,
    requestIdentity: string,
    timeoutSeconds: number,
  ): { id: number; attemptId: string } | undefined {
    const now = new Date().toISOString();
    const stale = new Date(
      Date.now() - (timeoutSeconds + 600) * 1000,
    ).toISOString();
    const attemptId = crypto.randomUUID();
    const row = this.db
      .query(`
        INSERT INTO reviews
          (repository, pr_number, head_sha, request_identity, status, started_at, attempt_id)
        VALUES (?, ?, ?, ?, 'running', ?, ?)
        ON CONFLICT (repository, pr_number, head_sha) DO UPDATE SET
          status = 'running',
          started_at = excluded.started_at,
          request_identity = excluded.request_identity,
          attempt_id = excluded.attempt_id,
          completed_at = NULL,
          error = NULL
        WHERE reviews.status IN ('pending', 'failed')
          OR (reviews.status = 'running' AND reviews.started_at < ?)
        RETURNING id
      `)
      .get(
        repository,
        number,
        head,
        requestIdentity,
        now,
        attemptId,
        stale,
      ) as { id: number } | null;
    return row ? { id: row.id, attemptId } : undefined;
  }

  isActive(claim: { id: number; attemptId: string }): boolean {
    const row = this.db
      .query(
        "SELECT 1 AS active FROM reviews WHERE id = ? AND attempt_id = ? AND status = 'running'",
      )
      .get(claim.id, claim.attemptId);
    return row !== null && row !== undefined;
  }

  complete(claim: { id: number; attemptId: string }, reviewId: number): void {
    const result = this.db
      .query(`
        UPDATE reviews SET status = 'completed', completed_at = ?,
          published_review_id = ?, error = NULL
        WHERE id = ? AND attempt_id = ? AND status = 'running'
      `)
      .run(new Date().toISOString(), reviewId, claim.id, claim.attemptId);
    if (result.changes !== 1)
      throw new Error("Review claim was lost before completion");
  }

  fail(claim: { id: number; attemptId: string }, error: string): void {
    this.db
      .query(`
        UPDATE reviews SET status = 'failed', completed_at = ?, error = ?
        WHERE id = ? AND attempt_id = ? AND status = 'running'
      `)
      .run(
        new Date().toISOString(),
        error.slice(0, 4000),
        claim.id,
        claim.attemptId,
      );
  }

  recent(limit = 20): ReviewJob[] {
    return this.db
      .query(
        "SELECT id, repository, pr_number, head_sha, status, started_at, completed_at, published_review_id, error FROM reviews ORDER BY id DESC LIMIT ?",
      )
      .all(limit) as ReviewJob[];
  }

  recoverable(timeoutSeconds: number): string[] {
    const stale = new Date(
      Date.now() - (timeoutSeconds + 600) * 1000,
    ).toISOString();
    const rows = this.db
      .query(`
      SELECT repository, pr_number FROM reviews
      WHERE status = 'failed' OR (status = 'running' AND started_at < ?)
    `)
      .all(stale) as Array<{ repository: string; pr_number: number }>;
    return rows.map(
      ({ repository, pr_number }) =>
        `https://github.com/${repository}/pull/${pr_number}`,
    );
  }

  close(): void {
    this.db.close();
  }
}
