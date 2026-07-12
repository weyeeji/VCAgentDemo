#!/usr/bin/env node
/** Seed synthetic PDF fixtures and default workspace state for out-of-the-box demo use. */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_CONFIG,
  deepCloneConfig,
  deepCloneUserProfiles,
} from "../lib/defaults.ts";
import { DEMO_SEED_FILES } from "../lib/demo-seed-manifest.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PDF_DIR = path.join(ROOT, "output", "pdf");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const DB_PATH = path.join(DATA_DIR, "app.db");
const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 120;
const MAX_EXTRACTED_CHARS = 500_000;
const SEED_TIMESTAMP = "2026-07-12T00:00:00.000Z";

function normalizeText(value: string): string {
  return value
    .replaceAll("\u0000", "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_EXTRACTED_CHARS);
}

function chunkText(text: string): Array<{ content: string; location: string }> {
  if (!text) return [];
  const chunks: Array<{ content: string; location: string }> = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK_SIZE);
    if (end < text.length) {
      const breakAt = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf("。", end), text.lastIndexOf("；", end));
      if (breakAt > start + CHUNK_SIZE * 0.55) end = breakAt + 1;
    }
    const content = text.slice(start, end).trim();
    if (content) chunks.push({ content, location: `字符 ${start + 1}-${end}` });
    if (end >= text.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }
  return chunks;
}

function initDatabase(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_files (
      id TEXT PRIMARY KEY,
      agent_role TEXT NOT NULL CHECK (agent_role IN ('investor', 'founder')),
      original_name TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'error')),
      error TEXT,
      extracted_chars INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_files_role ON agent_files(agent_role, created_at);
    CREATE TABLE IF NOT EXISTS file_chunks (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES agent_files(id) ON DELETE CASCADE,
      agent_role TEXT NOT NULL CHECK (agent_role IN ('investor', 'founder')),
      chunk_index INTEGER NOT NULL,
      location TEXT NOT NULL,
      content TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_file_chunks_scope ON file_chunks(agent_role, file_id, chunk_index);
    CREATE TABLE IF NOT EXISTS workspace_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

async function importSeedFile(database: DatabaseSync, spec: (typeof DEMO_SEED_FILES)[number]): Promise<void> {
  const pdfModule = await import("pdf-parse/lib/pdf-parse.js");
  const pdfParse = pdfModule.default as (buffer: Buffer) => Promise<{ text: string }>;
  const sourcePath = path.join(PDF_DIR, spec.pdfName);
  const buffer = await readFile(sourcePath);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const text = normalizeText((await pdfParse(buffer)).text);
  if (!text) throw new Error(`${spec.pdfName} 未提取到文本`);
  const chunks = chunkText(text);
  const fileDir = path.join(UPLOAD_DIR, spec.role, spec.id);
  const storedPath = path.join(fileDir, "source.pdf");
  await mkdir(fileDir, { recursive: true });
  await writeFile(storedPath, buffer, { flag: "w" });
  database.prepare("DELETE FROM agent_files WHERE id = ? AND agent_role = ?").run(spec.id, spec.role);
  database.prepare(`INSERT INTO agent_files
    (id, agent_role, original_name, stored_path, mime_type, size, sha256, status, error, extracted_chars, chunk_count, created_at)
    VALUES (?, ?, ?, ?, 'application/pdf', ?, ?, 'ready', NULL, ?, ?, ?)`)
    .run(spec.id, spec.role, spec.pdfName, storedPath, buffer.length, sha256, text.length, chunks.length, SEED_TIMESTAMP);
  const insert = database.prepare("INSERT INTO file_chunks (id, file_id, agent_role, chunk_index, location, content) VALUES (?, ?, ?, ?, ?, ?)");
  chunks.forEach((chunk, index) => {
    insert.run(randomUUID(), spec.id, spec.role, index, chunk.location, chunk.content);
  });
  console.log(`seeded ${spec.role}/${spec.pdfName} -> ${spec.id}`);
}

function buildDefaultWorkspaceState() {
  return {
    schemaVersion: 1 as const,
    config: deepCloneConfig(DEFAULT_CONFIG),
    profiles: deepCloneUserProfiles(),
    versions: [],
    records: [],
    directChats: {
      investor: { activeThreadId: null, threads: [] },
      founder: { activeThreadId: null, threads: [] },
    },
    memories: { investor: null, founder: null },
    dailyReports: { investor: null, founder: null },
    activeVersion: null,
    activeRecordId: null,
    updatedAt: SEED_TIMESTAMP,
  };
}

async function resetDemoFiles(database: DatabaseSync): Promise<void> {
  const rows = database.prepare("SELECT stored_path FROM agent_files").all() as Array<{ stored_path: string }>;
  for (const row of rows) {
    await rm(path.dirname(row.stored_path), { recursive: true, force: true });
  }
  database.prepare("DELETE FROM file_chunks").run();
  database.prepare("DELETE FROM agent_files").run();
}

async function main(): Promise<void> {
  await mkdir(PDF_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });
  for (const spec of DEMO_SEED_FILES) {
    await readFile(path.join(PDF_DIR, spec.pdfName));
  }

  const database = new DatabaseSync(DB_PATH);
  initDatabase(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    await resetDemoFiles(database);
    for (const spec of DEMO_SEED_FILES) {
      await importSeedFile(database, spec);
    }
    const state = buildDefaultWorkspaceState();
    database.prepare(`INSERT INTO workspace_state (id, state_json, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`)
      .run(JSON.stringify(state), SEED_TIMESTAMP);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  console.log(`Demo data seeded into ${DATA_DIR}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
