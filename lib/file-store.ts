import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentFileRecord, AgentRole, FileSearchResult } from "./types";

export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const MAX_FILES_PER_AGENT = 20;
export const MAX_EXTRACTED_CHARS = 500_000;
const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 120;
const ALLOWED_EXTENSIONS = new Set([".pdf", ".docx", ".txt", ".md", ".markdown", ".csv"]);
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const DB_PATH = path.join(DATA_DIR, "app.db");

declare global {
  var __ventureFileDb: DatabaseSync | undefined;
}

function db(): DatabaseSync {
  if (globalThis.__ventureFileDb) return globalThis.__ventureFileDb;
  const database = new DatabaseSync(DB_PATH);
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
  `);
  globalThis.__ventureFileDb = database;
  return database;
}

export function isAgentRole(value: unknown): value is AgentRole {
  return value === "investor" || value === "founder";
}

function mapFile(row: Record<string, unknown>): AgentFileRecord {
  return {
    id: String(row.id),
    agentRole: row.agent_role as AgentRole,
    originalName: String(row.original_name),
    mimeType: String(row.mime_type),
    size: Number(row.size),
    sha256: String(row.sha256),
    status: row.status as AgentFileRecord["status"],
    error: row.error == null ? null : String(row.error),
    extractedChars: Number(row.extracted_chars),
    chunkCount: Number(row.chunk_count),
    createdAt: String(row.created_at),
  };
}

export async function initializeFileStore(): Promise<void> {
  await mkdir(UPLOAD_DIR, { recursive: true });
  db();
}

export async function listAgentFiles(role: AgentRole): Promise<AgentFileRecord[]> {
  await initializeFileStore();
  const rows = db().prepare("SELECT * FROM agent_files WHERE agent_role = ? ORDER BY created_at DESC").all(role);
  return rows.map((row) => mapFile(row as Record<string, unknown>));
}

function sanitizeExtension(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error("仅支持 PDF、DOCX、TXT、Markdown 和 CSV 文件。 ");
  return extension;
}

function normalizeText(value: string): string {
  return value
    .replaceAll("\u0000", "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_EXTRACTED_CHARS);
}

async function extractText(buffer: Buffer, extension: string): Promise<string> {
  if ([".txt", ".md", ".markdown", ".csv"].includes(extension)) return normalizeText(buffer.toString("utf8"));
  if (extension === ".docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return normalizeText(result.value);
  }
  if (extension === ".pdf") {
    const pdfModule = await import("pdf-parse");
    const parse = pdfModule.default;
    const result = await parse(buffer);
    return normalizeText(result.text);
  }
  throw new Error("不支持的文件类型。 ");
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

export async function storeAgentFile(role: AgentRole, file: File): Promise<AgentFileRecord> {
  await initializeFileStore();
  if (file.size <= 0) throw new Error("文件为空。 ");
  if (file.size > MAX_FILE_SIZE) throw new Error("单个文件不能超过 10MB。 ");
  const currentCount = Number((db().prepare("SELECT COUNT(*) AS count FROM agent_files WHERE agent_role = ?").get(role) as { count: number }).count);
  if (currentCount >= MAX_FILES_PER_AGENT) throw new Error(`每个 Agent 最多上传 ${MAX_FILES_PER_AGENT} 个文件。`);

  const extension = sanitizeExtension(file.name);
  const buffer = Buffer.from(await file.arrayBuffer());
  const fileId = randomUUID();
  const fileDir = path.join(UPLOAD_DIR, role, fileId);
  const storedPath = path.join(fileDir, `source${extension}`);
  const createdAt = new Date().toISOString();
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  await mkdir(fileDir, { recursive: true });
  await writeFile(storedPath, buffer, { flag: "wx" });
  db().prepare(`INSERT INTO agent_files
    (id, agent_role, original_name, stored_path, mime_type, size, sha256, status, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', NULL, ?)`)
    .run(fileId, role, path.basename(file.name), storedPath, file.type || "application/octet-stream", file.size, sha256, createdAt);

  try {
    const text = await extractText(buffer, extension);
    if (!text) throw new Error("未从文件中提取到文本；扫描版 PDF 暂不支持 OCR。 ");
    const chunks = chunkText(text);
    const database = db();
    database.exec("BEGIN IMMEDIATE");
    try {
      const insert = database.prepare("INSERT INTO file_chunks (id, file_id, agent_role, chunk_index, location, content) VALUES (?, ?, ?, ?, ?, ?)");
      chunks.forEach((chunk, index) => insert.run(randomUUID(), fileId, role, index, chunk.location, chunk.content));
      database.prepare("UPDATE agent_files SET status = 'ready', extracted_chars = ?, chunk_count = ? WHERE id = ? AND agent_role = ?")
        .run(text.length, chunks.length, fileId, role);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db().prepare("UPDATE agent_files SET status = 'error', error = ? WHERE id = ? AND agent_role = ?").run(message.slice(0, 500), fileId, role);
  }

  const row = db().prepare("SELECT * FROM agent_files WHERE id = ? AND agent_role = ?").get(fileId, role);
  return mapFile(row as Record<string, unknown>);
}

export async function deleteAgentFile(role: AgentRole, fileId: string): Promise<boolean> {
  await initializeFileStore();
  const row = db().prepare("SELECT stored_path FROM agent_files WHERE id = ? AND agent_role = ?").get(fileId, role) as { stored_path: string } | undefined;
  if (!row) return false;
  db().prepare("DELETE FROM agent_files WHERE id = ? AND agent_role = ?").run(fileId, role);
  await rm(path.dirname(row.stored_path), { recursive: true, force: true });
  return true;
}

function isValidFileId(fileId: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(fileId);
}

export function contentTypeForFile(record: AgentFileRecord): string {
  const extension = path.extname(record.originalName).toLowerCase();
  const mapping: Record<string, string> = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".markdown": "text/markdown; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
  };
  return mapping[extension] || record.mimeType || "application/octet-stream";
}

export function canPreviewFileInline(record: AgentFileRecord): boolean {
  const extension = path.extname(record.originalName).toLowerCase();
  return [".pdf", ".txt", ".md", ".markdown", ".csv"].includes(extension);
}

export async function readAgentFile(
  role: AgentRole,
  fileId: string,
): Promise<{ record: AgentFileRecord; buffer: Buffer } | null> {
  await initializeFileStore();
  if (!isValidFileId(fileId)) return null;
  const row = db().prepare("SELECT * FROM agent_files WHERE id = ? AND agent_role = ?").get(fileId, role) as Record<string, unknown> | undefined;
  if (!row) return null;
  try {
    const buffer = await readFile(String(row.stored_path));
    return { record: mapFile(row), buffer };
  } catch {
    return null;
  }
}

function searchTerms(query: string): string[] {
  const normalized = query.toLowerCase().replace(/\s+/g, " ").trim();
  const terms = new Set<string>();
  normalized.match(/[a-z0-9][a-z0-9._%+-]*/g)?.forEach((term) => terms.add(term));
  const chinese = normalized.replace(/[^\u3400-\u9fff]/g, "");
  for (let index = 0; index < chinese.length - 1; index += 1) terms.add(chinese.slice(index, index + 2));
  normalized.split(/[\s,，。；;:：!?！？、/]+/).filter((term) => term.length >= 2).forEach((term) => terms.add(term));
  return [...terms].slice(0, 40);
}

export async function searchAgentFiles(role: AgentRole, query: string, topK: number, allowedFileIds: string[]): Promise<FileSearchResult[]> {
  await initializeFileStore();
  const scopedIds = [...new Set(allowedFileIds)].filter((value) => /^[0-9a-f-]{36}$/i.test(value)).slice(0, MAX_FILES_PER_AGENT);
  if (!query.trim() || !scopedIds.length) return [];
  const placeholders = scopedIds.map(() => "?").join(",");
  const rows = db().prepare(`SELECT c.id, c.file_id, c.location, c.content, f.original_name
    FROM file_chunks c JOIN agent_files f ON f.id = c.file_id
    WHERE c.agent_role = ? AND f.agent_role = ? AND f.status = 'ready' AND c.file_id IN (${placeholders})`)
    .all(role, role, ...scopedIds) as Array<Record<string, unknown>>;
  const normalizedQuery = query.toLowerCase().trim();
  const terms = searchTerms(query);
  return rows.map((row) => {
    const content = String(row.content);
    const haystack = `${String(row.original_name)}\n${content}`.toLowerCase();
    let score = haystack.includes(normalizedQuery) ? 12 : 0;
    for (const term of terms) {
      let cursor = 0;
      let count = 0;
      while ((cursor = haystack.indexOf(term, cursor)) >= 0 && count < 8) { count += 1; cursor += term.length; }
      score += count * (term.length >= 4 ? 2.2 : 1);
    }
    score = score / Math.sqrt(Math.max(1, content.length / 500));
    return {
      fileId: String(row.file_id), fileName: String(row.original_name), chunkId: String(row.id),
      location: String(row.location), content, score: Number(score.toFixed(4)),
    };
  }).filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.min(8, Math.max(1, topK || 5)));
}

export const PRIVATE_FILE_TOOL = {
  type: "function",
  function: {
    name: "search_private_files",
    description: "在当前 Agent 自己的私有上传文件中检索与当前问题相关的内容。工具作用域由服务端绑定，不能访问另一个 Agent 的文件。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "用于查找相关文件片段的具体问题或关键词" },
        top_k: { type: "integer", minimum: 1, maximum: 8, description: "最多返回的相关片段数，默认 5" },
      },
      required: ["query"],
    },
  },
} as const;
