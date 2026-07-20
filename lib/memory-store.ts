import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentActionProposal,
  AgentMemoryItem,
  AgentRole,
  AgentTaskItem,
  AgentTaskStatus,
  MemoryKind,
  MemoryStatus,
  MemoryVerification,
} from "./types";

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "app.db");
const MAX_TEXT_CHARS = 20_000;

declare global {
  var __ventureMemoryDb: DatabaseSync | undefined;
}

export class AgentStateConflictError extends Error {
  constructor(message = "记忆或任务已被其他操作更新，请刷新后重试。") {
    super(message);
    this.name = "AgentStateConflictError";
  }
}

export interface CreateMemoryInput {
  kind: MemoryKind;
  title: string;
  content: string;
  verification?: MemoryVerification;
  priority?: number;
  counterpartyId?: string | null;
  sourceType?: string;
  sourceId?: string | null;
  metadata?: Record<string, unknown>;
  supersedesId?: string | null;
}

export interface UpdateMemoryInput extends Partial<Omit<CreateMemoryInput, "sourceType" | "sourceId">> {
  status?: MemoryStatus;
  expectedVersion?: number;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: AgentTaskStatus;
  priority?: number;
  dueAt?: string | null;
  counterpartyId?: string | null;
  sourceMemoryId?: string | null;
  sourceType?: string;
  sourceId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface UpdateTaskInput extends Partial<Omit<CreateTaskInput, "sourceType" | "sourceId">> {
  expectedVersion?: number;
}

type MemoryRow = {
  id: string;
  scope_id: string;
  agent_id: string;
  agent_role: string;
  kind: string;
  title: string;
  content: string;
  verification: string;
  status: string;
  priority: number;
  counterparty_id: string | null;
  source_type: string;
  source_id: string | null;
  metadata_json: string;
  supersedes_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type TaskRow = {
  id: string;
  scope_id: string;
  agent_id: string;
  agent_role: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  due_at: string | null;
  counterparty_id: string | null;
  source_memory_id: string | null;
  source_type: string;
  source_id: string | null;
  metadata_json: string;
  version: number;
  created_at: string;
  updated_at: string;
};

function db(): DatabaseSync {
  if (globalThis.__ventureMemoryDb) return globalThis.__ventureMemoryDb;
  mkdirSync(DATA_DIR, { recursive: true });
  const database = new DatabaseSync(DB_PATH);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_memories (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_role TEXT NOT NULL CHECK (agent_role IN ('investor', 'founder')),
      kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'decision', 'constraint', 'note')),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      verification TEXT NOT NULL CHECK (verification IN ('confirmed', 'unverified', 'conflicted')),
      status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'archived', 'deleted')),
      priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 100),
      counterparty_id TEXT,
      source_type TEXT NOT NULL,
      source_id TEXT,
      metadata_json TEXT NOT NULL,
      supersedes_id TEXT,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_memories_scope_agent
      ON agent_memories(scope_id, agent_id, status, kind, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_memories_counterparty
      ON agent_memories(scope_id, agent_id, counterparty_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memories_source
      ON agent_memories(scope_id, agent_id, source_type, source_id)
      WHERE source_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_role TEXT NOT NULL CHECK (agent_role IN ('investor', 'founder')),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'blocked', 'done', 'cancelled')),
      priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 100),
      due_at TEXT,
      counterparty_id TEXT,
      source_memory_id TEXT,
      source_type TEXT NOT NULL,
      source_id TEXT,
      metadata_json TEXT NOT NULL,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_scope_agent
      ON agent_tasks(scope_id, agent_id, status, priority DESC, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_source
      ON agent_tasks(scope_id, agent_id, source_type, source_id)
      WHERE source_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS agent_state_events (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('memory', 'task')),
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      source_type TEXT NOT NULL,
      source_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_state_events_entity
      ON agent_state_events(scope_id, agent_id, entity_type, entity_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS agent_action_batches (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(scope_id, agent_id, source_type, source_id)
    );
  `);
  globalThis.__ventureMemoryDb = database;
  return database;
}

function now(): string {
  return new Date().toISOString();
}

function cleanText(value: unknown, label: string, maxLength = MAX_TEXT_CHARS): string {
  if (typeof value !== "string") throw new Error(`${label}必须是文本。`);
  const text = value.replaceAll("\0", "").trim();
  if (!text) throw new Error(`${label}不能为空。`);
  if (text.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符。`);
  return text;
}

function cleanOptionalText(value: unknown, label: string, maxLength = 200): string | null {
  if (value == null || value === "") return null;
  return cleanText(value, label, maxLength);
}

function cleanPriority(value: unknown, fallback = 50): number {
  const number = value == null ? fallback : Number(value);
  if (!Number.isFinite(number)) throw new Error("优先级必须是数字。");
  return Math.min(100, Math.max(0, Math.round(number)));
}

function cleanMetadata(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("metadata 必须是 JSON 对象。");
  const serialized = JSON.stringify(value);
  if (serialized.length > 20_000) throw new Error("metadata 内容过大。");
  return JSON.parse(serialized) as Record<string, unknown>;
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function memoryFromRow(row: MemoryRow): AgentMemoryItem {
  return {
    id: row.id,
    scopeId: row.scope_id,
    agentId: row.agent_id,
    agentRole: row.agent_role as AgentRole,
    kind: row.kind as MemoryKind,
    title: row.title,
    content: row.content,
    verification: row.verification as MemoryVerification,
    status: row.status as MemoryStatus,
    priority: row.priority,
    counterpartyId: row.counterparty_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    metadata: parseMetadata(row.metadata_json),
    supersedesId: row.supersedes_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function taskFromRow(row: TaskRow): AgentTaskItem {
  return {
    id: row.id,
    scopeId: row.scope_id,
    agentId: row.agent_id,
    agentRole: row.agent_role as AgentRole,
    title: row.title,
    description: row.description,
    status: row.status as AgentTaskStatus,
    priority: row.priority,
    dueAt: row.due_at,
    counterpartyId: row.counterparty_id,
    sourceMemoryId: row.source_memory_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    metadata: parseMetadata(row.metadata_json),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function writeEvent(
  database: DatabaseSync,
  scopeId: string,
  agentId: string,
  entityType: "memory" | "task",
  entityId: string,
  action: string,
  before: unknown,
  after: unknown,
  sourceType: string,
  sourceId: string | null,
) {
  database.prepare(`INSERT INTO agent_state_events
    (id, scope_id, agent_id, entity_type, entity_id, action, before_json, after_json, source_type, source_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`event_${randomUUID()}`, scopeId, agentId, entityType, entityId, action,
      before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after),
      sourceType, sourceId, now());
}

function getMemoryRow(database: DatabaseSync, scopeId: string, agentId: string, id: string): MemoryRow | null {
  return (database.prepare("SELECT * FROM agent_memories WHERE id = ? AND scope_id = ? AND agent_id = ?")
    .get(id, scopeId, agentId) as MemoryRow | undefined) || null;
}

function getTaskRow(database: DatabaseSync, scopeId: string, agentId: string, id: string): TaskRow | null {
  return (database.prepare("SELECT * FROM agent_tasks WHERE id = ? AND scope_id = ? AND agent_id = ?")
    .get(id, scopeId, agentId) as TaskRow | undefined) || null;
}

function createMemoryInternal(database: DatabaseSync, scopeId: string, agentId: string, role: AgentRole, input: CreateMemoryInput): AgentMemoryItem {
  const sourceType = cleanText(input.sourceType ?? "manual", "sourceType", 100);
  const sourceId = cleanOptionalText(input.sourceId, "sourceId");
  if (sourceId) {
    const existing = database.prepare(`SELECT * FROM agent_memories
      WHERE scope_id = ? AND agent_id = ? AND source_type = ? AND source_id = ?`)
      .get(scopeId, agentId, sourceType, sourceId) as MemoryRow | undefined;
    if (existing) return memoryFromRow(existing);
  }
  const kind = input.kind;
  if (!(["fact", "preference", "decision", "constraint", "note"] as string[]).includes(kind)) throw new Error("无效的记忆类型。");
  const verification = input.verification ?? "confirmed";
  if (!(["confirmed", "unverified", "conflicted"] as string[]).includes(verification)) throw new Error("无效的核实状态。");
  const id = `memory_${randomUUID()}`;
  const timestamp = now();
  const item: AgentMemoryItem = {
    id,
    scopeId,
    agentId,
    agentRole: role,
    kind,
    title: cleanText(input.title, "记忆标题", 300),
    content: cleanText(input.content, "记忆内容"),
    verification,
    status: "active",
    priority: cleanPriority(input.priority),
    counterpartyId: cleanOptionalText(input.counterpartyId, "counterpartyId"),
    sourceType,
    sourceId,
    metadata: cleanMetadata(input.metadata),
    supersedesId: cleanOptionalText(input.supersedesId, "supersedesId"),
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
  };
  database.prepare(`INSERT INTO agent_memories
    (id, scope_id, agent_id, agent_role, kind, title, content, verification, status, priority,
      counterparty_id, source_type, source_id, metadata_json, supersedes_id, version, created_at, updated_at, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(item.id, item.scopeId, item.agentId, item.agentRole, item.kind, item.title, item.content,
      item.verification, item.status, item.priority, item.counterpartyId, item.sourceType, item.sourceId,
      JSON.stringify(item.metadata), item.supersedesId, item.version, item.createdAt, item.updatedAt, item.archivedAt);
  if (item.supersedesId) {
    const previous = getMemoryRow(database, scopeId, agentId, item.supersedesId);
    if (previous && previous.status === "active") {
      database.prepare("UPDATE agent_memories SET status = 'superseded', version = version + 1, updated_at = ? WHERE id = ?")
        .run(timestamp, previous.id);
      writeEvent(database, scopeId, agentId, "memory", previous.id, "superseded", memoryFromRow(previous),
        memoryFromRow(getMemoryRow(database, scopeId, agentId, previous.id)!), sourceType, sourceId);
    }
  }
  writeEvent(database, scopeId, agentId, "memory", item.id, "created", null, item, sourceType, sourceId);
  return item;
}

function updateMemoryInternal(
  database: DatabaseSync,
  scopeId: string,
  agentId: string,
  id: string,
  input: UpdateMemoryInput,
  sourceType = "manual",
  sourceId: string | null = null,
): AgentMemoryItem {
  const row = getMemoryRow(database, scopeId, agentId, id);
  if (!row) throw new Error("记忆不存在或不属于当前 Agent。");
  if (input.expectedVersion != null && row.version !== input.expectedVersion) throw new AgentStateConflictError();
  const before = memoryFromRow(row);
  const next: AgentMemoryItem = {
    ...before,
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.title === undefined ? {} : { title: cleanText(input.title, "记忆标题", 300) }),
    ...(input.content === undefined ? {} : { content: cleanText(input.content, "记忆内容") }),
    ...(input.verification === undefined ? {} : { verification: input.verification }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.priority === undefined ? {} : { priority: cleanPriority(input.priority) }),
    ...(input.counterpartyId === undefined ? {} : { counterpartyId: cleanOptionalText(input.counterpartyId, "counterpartyId") }),
    ...(input.metadata === undefined ? {} : { metadata: cleanMetadata(input.metadata) }),
    ...(input.supersedesId === undefined ? {} : { supersedesId: cleanOptionalText(input.supersedesId, "supersedesId") }),
    version: before.version + 1,
    updatedAt: now(),
    archivedAt: input.status === "archived" || input.status === "deleted" ? now()
      : input.status === "active" ? null : before.archivedAt,
  };
  if (!(["fact", "preference", "decision", "constraint", "note"] as string[]).includes(next.kind)) throw new Error("无效的记忆类型。");
  if (!(["confirmed", "unverified", "conflicted"] as string[]).includes(next.verification)) throw new Error("无效的核实状态。");
  if (!(["active", "superseded", "archived", "deleted"] as string[]).includes(next.status)) throw new Error("无效的记忆状态。");
  database.prepare(`UPDATE agent_memories SET kind = ?, title = ?, content = ?, verification = ?, status = ?, priority = ?,
    counterparty_id = ?, metadata_json = ?, supersedes_id = ?, version = ?, updated_at = ?, archived_at = ?
    WHERE id = ? AND scope_id = ? AND agent_id = ?`)
    .run(next.kind, next.title, next.content, next.verification, next.status, next.priority, next.counterpartyId,
      JSON.stringify(next.metadata), next.supersedesId, next.version, next.updatedAt, next.archivedAt, id, scopeId, agentId);
  writeEvent(database, scopeId, agentId, "memory", id, next.status === "active" && before.status !== "active" ? "restored" : "updated",
    before, next, sourceType, sourceId);
  return next;
}

function createTaskInternal(database: DatabaseSync, scopeId: string, agentId: string, role: AgentRole, input: CreateTaskInput): AgentTaskItem {
  const sourceType = cleanText(input.sourceType ?? "manual", "sourceType", 100);
  const sourceId = cleanOptionalText(input.sourceId, "sourceId");
  if (sourceId) {
    const existing = database.prepare(`SELECT * FROM agent_tasks
      WHERE scope_id = ? AND agent_id = ? AND source_type = ? AND source_id = ?`)
      .get(scopeId, agentId, sourceType, sourceId) as TaskRow | undefined;
    if (existing) return taskFromRow(existing);
  }
  const status = input.status ?? "todo";
  if (!(["todo", "in_progress", "blocked", "done", "cancelled"] as string[]).includes(status)) throw new Error("无效的任务状态。");
  const timestamp = now();
  const item: AgentTaskItem = {
    id: `task_${randomUUID()}`,
    scopeId,
    agentId,
    agentRole: role,
    title: cleanText(input.title, "任务标题", 300),
    description: typeof input.description === "string" ? input.description.replaceAll("\0", "").trim().slice(0, MAX_TEXT_CHARS) : "",
    status,
    priority: cleanPriority(input.priority),
    dueAt: cleanOptionalText(input.dueAt, "dueAt", 100),
    counterpartyId: cleanOptionalText(input.counterpartyId, "counterpartyId"),
    sourceMemoryId: cleanOptionalText(input.sourceMemoryId, "sourceMemoryId"),
    sourceType,
    sourceId,
    metadata: cleanMetadata(input.metadata),
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  database.prepare(`INSERT INTO agent_tasks
    (id, scope_id, agent_id, agent_role, title, description, status, priority, due_at, counterparty_id,
      source_memory_id, source_type, source_id, metadata_json, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(item.id, item.scopeId, item.agentId, item.agentRole, item.title, item.description, item.status,
      item.priority, item.dueAt, item.counterpartyId, item.sourceMemoryId, item.sourceType, item.sourceId,
      JSON.stringify(item.metadata), item.version, item.createdAt, item.updatedAt);
  writeEvent(database, scopeId, agentId, "task", item.id, "created", null, item, sourceType, sourceId);
  return item;
}

function updateTaskInternal(
  database: DatabaseSync,
  scopeId: string,
  agentId: string,
  id: string,
  input: UpdateTaskInput,
  sourceType = "manual",
  sourceId: string | null = null,
): AgentTaskItem {
  const row = getTaskRow(database, scopeId, agentId, id);
  if (!row) throw new Error("任务不存在或不属于当前 Agent。");
  if (input.expectedVersion != null && row.version !== input.expectedVersion) throw new AgentStateConflictError();
  const before = taskFromRow(row);
  const next: AgentTaskItem = {
    ...before,
    ...(input.title === undefined ? {} : { title: cleanText(input.title, "任务标题", 300) }),
    ...(input.description === undefined ? {} : { description: String(input.description).replaceAll("\0", "").trim().slice(0, MAX_TEXT_CHARS) }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.priority === undefined ? {} : { priority: cleanPriority(input.priority) }),
    ...(input.dueAt === undefined ? {} : { dueAt: cleanOptionalText(input.dueAt, "dueAt", 100) }),
    ...(input.counterpartyId === undefined ? {} : { counterpartyId: cleanOptionalText(input.counterpartyId, "counterpartyId") }),
    ...(input.sourceMemoryId === undefined ? {} : { sourceMemoryId: cleanOptionalText(input.sourceMemoryId, "sourceMemoryId") }),
    ...(input.metadata === undefined ? {} : { metadata: cleanMetadata(input.metadata) }),
    version: before.version + 1,
    updatedAt: now(),
  };
  if (!(["todo", "in_progress", "blocked", "done", "cancelled"] as string[]).includes(next.status)) throw new Error("无效的任务状态。");
  database.prepare(`UPDATE agent_tasks SET title = ?, description = ?, status = ?, priority = ?, due_at = ?,
    counterparty_id = ?, source_memory_id = ?, metadata_json = ?, version = ?, updated_at = ?
    WHERE id = ? AND scope_id = ? AND agent_id = ?`)
    .run(next.title, next.description, next.status, next.priority, next.dueAt, next.counterpartyId,
      next.sourceMemoryId, JSON.stringify(next.metadata), next.version, next.updatedAt, id, scopeId, agentId);
  writeEvent(database, scopeId, agentId, "task", id, "updated", before, next, sourceType, sourceId);
  return next;
}

function transaction<T>(work: (database: DatabaseSync) => T): T {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work(database);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function listMemories(scopeId: string, agentId: string, options: {
  status?: MemoryStatus | "all";
  kind?: MemoryKind;
  counterpartyId?: string | null;
  query?: string;
  limit?: number;
} = {}): AgentMemoryItem[] {
  const clauses = ["scope_id = ?", "agent_id = ?"];
  const params: Array<string | number | null> = [scopeId, agentId];
  if (options.status !== "all") {
    clauses.push("status = ?");
    params.push(options.status ?? "active");
  }
  if (options.kind) { clauses.push("kind = ?"); params.push(options.kind); }
  if (options.counterpartyId !== undefined) {
    clauses.push(options.counterpartyId === null ? "counterparty_id IS NULL" : "counterparty_id = ?");
    if (options.counterpartyId !== null) params.push(options.counterpartyId);
  }
  const query = options.query?.trim().slice(0, 300);
  if (query) {
    clauses.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')");
    const pattern = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    params.push(pattern, pattern);
  }
  const limit = Math.min(500, Math.max(1, options.limit ?? 200));
  params.push(limit);
  const rows = db().prepare(`SELECT * FROM agent_memories WHERE ${clauses.join(" AND ")}
    ORDER BY priority DESC, updated_at DESC LIMIT ?`).all(...params) as MemoryRow[];
  return rows.map(memoryFromRow);
}

export function getMemory(scopeId: string, agentId: string, id: string): AgentMemoryItem | null {
  const row = getMemoryRow(db(), scopeId, agentId, id);
  return row ? memoryFromRow(row) : null;
}

export function createMemory(scopeId: string, agentId: string, role: AgentRole, input: CreateMemoryInput): AgentMemoryItem {
  return transaction((database) => createMemoryInternal(database, scopeId, agentId, role, input));
}

export function updateMemory(scopeId: string, agentId: string, id: string, input: UpdateMemoryInput): AgentMemoryItem {
  return transaction((database) => updateMemoryInternal(database, scopeId, agentId, id, input));
}

export function archiveMemory(scopeId: string, agentId: string, id: string, expectedVersion?: number): AgentMemoryItem {
  return transaction((database) => updateMemoryInternal(database, scopeId, agentId, id, { status: "archived", expectedVersion }));
}

export function listTasks(scopeId: string, agentId: string, options: {
  status?: AgentTaskStatus | "active" | "all";
  counterpartyId?: string | null;
  limit?: number;
} = {}): AgentTaskItem[] {
  const clauses = ["scope_id = ?", "agent_id = ?"];
  const params: Array<string | number | null> = [scopeId, agentId];
  if (options.status === "active" || options.status === undefined) clauses.push("status IN ('todo', 'in_progress', 'blocked')");
  else if (options.status !== "all") { clauses.push("status = ?"); params.push(options.status); }
  if (options.counterpartyId !== undefined) {
    clauses.push(options.counterpartyId === null ? "counterparty_id IS NULL" : "counterparty_id = ?");
    if (options.counterpartyId !== null) params.push(options.counterpartyId);
  }
  const limit = Math.min(500, Math.max(1, options.limit ?? 200));
  params.push(limit);
  const rows = db().prepare(`SELECT * FROM agent_tasks WHERE ${clauses.join(" AND ")}
    ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'blocked' THEN 1 ELSE 2 END,
      priority DESC, COALESCE(due_at, '9999') ASC, updated_at DESC LIMIT ?`).all(...params) as TaskRow[];
  return rows.map(taskFromRow);
}

export function createTask(scopeId: string, agentId: string, role: AgentRole, input: CreateTaskInput): AgentTaskItem {
  return transaction((database) => createTaskInternal(database, scopeId, agentId, role, input));
}

export function updateTask(scopeId: string, agentId: string, id: string, input: UpdateTaskInput): AgentTaskItem {
  return transaction((database) => updateTaskInternal(database, scopeId, agentId, id, input));
}

export function commitAgentActions(
  scopeId: string,
  agentId: string,
  role: AgentRole,
  actions: AgentActionProposal[],
  sourceType: string,
  sourceId: string | null,
): { memories: AgentMemoryItem[]; tasks: AgentTaskItem[] } {
  if (!actions.length || actions.length > 20) throw new Error("一次必须执行 1–20 个行动。");
  const normalizedSourceType = cleanText(sourceType, "sourceType", 100);
  const normalizedSourceId = cleanOptionalText(sourceId, "sourceId");
  return transaction((database) => {
    if (normalizedSourceId) {
      const existing = database.prepare(`SELECT result_json FROM agent_action_batches
        WHERE scope_id = ? AND agent_id = ? AND source_type = ? AND source_id = ?`)
        .get(scopeId, agentId, normalizedSourceType, normalizedSourceId) as { result_json: string } | undefined;
      if (existing) return JSON.parse(existing.result_json) as { memories: AgentMemoryItem[]; tasks: AgentTaskItem[] };
    }
    const memories: AgentMemoryItem[] = [];
    const tasks: AgentTaskItem[] = [];
    actions.forEach((action, index) => {
      const actionSourceId = normalizedSourceId ? `${normalizedSourceId}:${index}` : null;
      if (action.type === "memory.create") {
        memories.push(createMemoryInternal(database, scopeId, agentId, role, {
          kind: action.input.kind as MemoryKind,
          title: action.input.title as string,
          content: action.input.content as string,
          verification: "confirmed",
          priority: action.input.priority as number | undefined,
          counterpartyId: action.input.counterpartyId as string | null | undefined,
          supersedesId: action.input.supersedesId as string | null | undefined,
          metadata: { ...cleanMetadata(action.input.metadata), approvedActionId: action.id, reason: action.reason },
          sourceType: normalizedSourceType,
          sourceId: actionSourceId,
        }));
      } else if (action.type === "memory.update") {
        if (!action.memoryId) throw new Error("memory.update 缺少 memoryId。");
        if (!Number.isInteger(action.input.expectedVersion) || Number(action.input.expectedVersion) < 1) {
          throw new Error("memory.update 缺少有效的 expectedVersion。");
        }
        memories.push(updateMemoryInternal(database, scopeId, agentId, action.memoryId, {
          ...(action.input.kind === undefined ? {} : { kind: action.input.kind as MemoryKind }),
          ...(action.input.title === undefined ? {} : { title: action.input.title as string }),
          ...(action.input.content === undefined ? {} : { content: action.input.content as string }),
          ...(action.input.priority === undefined ? {} : { priority: action.input.priority as number }),
          ...(action.input.counterpartyId === undefined ? {} : { counterpartyId: action.input.counterpartyId as string | null }),
          verification: "confirmed",
          expectedVersion: action.input.expectedVersion as number | undefined,
        }, normalizedSourceType, actionSourceId));
      } else if (action.type === "memory.archive") {
        if (!action.memoryId) throw new Error("memory.archive 缺少 memoryId。");
        if (!Number.isInteger(action.input.expectedVersion) || Number(action.input.expectedVersion) < 1) {
          throw new Error("memory.archive 缺少有效的 expectedVersion。");
        }
        memories.push(updateMemoryInternal(database, scopeId, agentId, action.memoryId, {
          status: "archived",
          expectedVersion: action.input.expectedVersion as number | undefined,
        }, normalizedSourceType, actionSourceId));
      } else if (action.type === "task.create") {
        tasks.push(createTaskInternal(database, scopeId, agentId, role, {
          title: action.input.title as string,
          description: action.input.description as string | undefined,
          status: (action.input.status as AgentTaskStatus | undefined) ?? "todo",
          priority: action.input.priority as number | undefined,
          dueAt: action.input.dueAt as string | null | undefined,
          counterpartyId: action.input.counterpartyId as string | null | undefined,
          sourceMemoryId: action.input.sourceMemoryId as string | null | undefined,
          metadata: { ...cleanMetadata(action.input.metadata), approvedActionId: action.id, reason: action.reason },
          sourceType: normalizedSourceType,
          sourceId: actionSourceId,
        }));
      } else if (action.type === "task.update" || action.type === "task.cancel") {
        if (!action.taskId) throw new Error(`${action.type} 缺少 taskId。`);
        if (!Number.isInteger(action.input.expectedVersion) || Number(action.input.expectedVersion) < 1) {
          throw new Error(`${action.type} 缺少有效的 expectedVersion。`);
        }
        tasks.push(updateTaskInternal(database, scopeId, agentId, action.taskId, {
          ...(action.input.title === undefined ? {} : { title: action.input.title as string }),
          ...(action.input.description === undefined ? {} : { description: action.input.description as string }),
          ...(action.input.priority === undefined ? {} : { priority: action.input.priority as number }),
          ...(action.input.dueAt === undefined ? {} : { dueAt: action.input.dueAt as string | null }),
          ...(action.input.status === undefined ? {} : { status: action.input.status as AgentTaskStatus }),
          ...(action.type === "task.cancel" ? { status: "cancelled" as const } : {}),
          expectedVersion: action.input.expectedVersion as number | undefined,
        }, normalizedSourceType, actionSourceId));
      } else {
        throw new Error(`不支持的行动类型：${String(action.type)}`);
      }
    });
    const result = { memories, tasks };
    if (normalizedSourceId) {
      database.prepare(`INSERT INTO agent_action_batches
        (id, scope_id, agent_id, source_type, source_id, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(`batch_${randomUUID()}`, scopeId, agentId, normalizedSourceType, normalizedSourceId, JSON.stringify(result), now());
    }
    return result;
  });
}
