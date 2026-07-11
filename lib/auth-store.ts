import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), "data");

declare global {
  var __ventureAuthDb: DatabaseSync | undefined;
}

function db(): DatabaseSync {
  if (globalThis.__ventureAuthDb) return globalThis.__ventureAuthDb;
  mkdirSync(DATA_DIR, { recursive: true });
  const database = new DatabaseSync(path.join(DATA_DIR, "app.db"));
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(`CREATE TABLE IF NOT EXISTS login_attempts (
    key_hash TEXT PRIMARY KEY,
    failure_count INTEGER NOT NULL,
    reset_at INTEGER NOT NULL
  )`);
  globalThis.__ventureAuthDb = database;
  return database;
}

export function hashedAttemptKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canAttempt(key: string): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  db().prepare("DELETE FROM login_attempts WHERE reset_at <= ?").run(now);
  const current = db().prepare("SELECT failure_count, reset_at FROM login_attempts WHERE key_hash = ?").get(key) as { failure_count: number; reset_at: number } | undefined;
  if (!current) return { allowed: true, retryAfter: 0 };
  return { allowed: current.failure_count < MAX_ATTEMPTS, retryAfter: Math.max(1, Math.ceil((current.reset_at - now) / 1000)) };
}

export function recordFailure(key: string): void {
  const now = Date.now();
  db().prepare(`INSERT INTO login_attempts (key_hash, failure_count, reset_at) VALUES (?, 1, ?)
    ON CONFLICT(key_hash) DO UPDATE SET
      failure_count = CASE WHEN reset_at <= ? THEN 1 ELSE failure_count + 1 END,
      reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END`)
    .run(key, now + WINDOW_MS, now, now);
}

export function clearFailures(key: string): void {
  db().prepare("DELETE FROM login_attempts WHERE key_hash = ?").run(key);
}
