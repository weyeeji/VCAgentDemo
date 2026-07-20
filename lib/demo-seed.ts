import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DEMO_SEED_FILES } from "./demo-seed-manifest";

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

async function importSeedFile(
  database: DatabaseSync,
  uploadDir: string,
  pdfDir: string,
  spec: (typeof DEMO_SEED_FILES)[number],
): Promise<void> {
  const pdfModule = await import("pdf-parse/lib/pdf-parse.js");
  const pdfParse = pdfModule.default as (buffer: Buffer) => Promise<{ text: string }>;
  const sourcePath = path.resolve(pdfDir, spec.sourceRelativePath || spec.pdfName);
  const buffer = await readFile(sourcePath);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const text = normalizeText((await pdfParse(buffer)).text);
  if (!text) throw new Error(`${spec.pdfName} 未提取到文本`);
  const chunks = chunkText(text);
  const fileDir = path.join(uploadDir, spec.role, spec.id);
  const storedPath = path.join(fileDir, "source.pdf");
  await mkdir(fileDir, { recursive: true });
  await writeFile(storedPath, buffer, { flag: "w" });
  database.prepare("DELETE FROM file_chunks WHERE file_id = ? AND agent_role = ?").run(spec.id, spec.role);
  database.prepare("DELETE FROM agent_files WHERE id = ? AND agent_role = ?").run(spec.id, spec.role);
  database.prepare(`INSERT INTO agent_files
    (id, agent_role, original_name, stored_path, mime_type, size, sha256, status, error, extracted_chars, chunk_count, created_at)
    VALUES (?, ?, ?, ?, 'application/pdf', ?, ?, 'ready', NULL, ?, ?, ?)`)
    .run(spec.id, spec.role, spec.pdfName, storedPath, buffer.length, sha256, text.length, chunks.length, SEED_TIMESTAMP);
  const insert = database.prepare("INSERT INTO file_chunks (id, file_id, agent_role, chunk_index, location, content) VALUES (?, ?, ?, ?, ?, ?)");
  chunks.forEach((chunk, index) => {
    insert.run(randomUUID(), spec.id, spec.role, index, chunk.location, chunk.content);
  });
}

/**
 * 若模拟 PDF 尚未入库，则从 output/pdf 自动导入。
 * 若已入库但 stored_path 指向其他机器的绝对路径（常见于拷贝 data/），则就地修复。
 * 启动后首次访问文件/工作区时会执行，保证服务器拉代码即可看到默认资料。
 */
export async function ensureDemoSeedFiles(database: DatabaseSync, uploadDir: string, pdfDir: string): Promise<void> {
  await mkdir(uploadDir, { recursive: true });
  let imported = false;
  let repaired = false;
  for (const spec of DEMO_SEED_FILES) {
    const existing = database.prepare("SELECT id, stored_path FROM agent_files WHERE id = ? AND agent_role = ? AND status = 'ready'")
      .get(spec.id, spec.role) as { id: string; stored_path: string } | undefined;
    if (existing) {
      const expectedPath = path.join(uploadDir, spec.role, spec.id, "source.pdf");
      try {
        await access(existing.stored_path);
        continue;
      } catch {
        try {
          await access(expectedPath);
          database.prepare("UPDATE agent_files SET stored_path = ? WHERE id = ? AND agent_role = ?")
            .run(expectedPath, spec.id, spec.role);
          repaired = true;
          continue;
        } catch {
          // fall through to re-import from output/pdf
        }
      }
    }
    try {
      await access(path.resolve(pdfDir, spec.sourceRelativePath || spec.pdfName));
    } catch {
      continue;
    }
    await importSeedFile(database, uploadDir, pdfDir, spec);
    imported = true;
  }
  if (imported) {
    console.info("[demo-seed] imported missing preset PDF fixtures");
  }
  if (repaired) {
    console.info("[demo-seed] repaired stale stored_path for preset PDF fixtures");
  }
}
