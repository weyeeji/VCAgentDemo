import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_CONFIG, deepCloneConfig } from "./defaults";
import type { AppConfig, SavedVersion, SimulationRecord, WorkspaceState, WorkspaceStatePatch } from "./types";

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "app.db");
const MAX_STATE_CHARS = 24_000_000;
const MAX_VERSIONS = 100;
const MAX_RECORDS = 20;

export class WorkspaceStateConflictError extends Error {
  currentState: WorkspaceState;

  constructor(currentState: WorkspaceState) {
    super("工作区已被另一个页面更新。");
    this.name = "WorkspaceStateConflictError";
    this.currentState = currentState;
  }
}

declare global {
  var __ventureWorkspaceDb: DatabaseSync | undefined;
}

function db(): DatabaseSync {
  if (globalThis.__ventureWorkspaceDb) return globalThis.__ventureWorkspaceDb;
  mkdirSync(DATA_DIR, { recursive: true });
  const database = new DatabaseSync(DB_PATH);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(`CREATE TABLE IF NOT EXISTS workspace_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  globalThis.__ventureWorkspaceDb = database;
  return database;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultState(): WorkspaceState {
  return {
    schemaVersion: 1,
    config: deepCloneConfig(DEFAULT_CONFIG),
    versions: [],
    records: [],
    memories: { investor: null, founder: null },
    dailyReports: { investor: null, founder: null },
    activeVersion: null,
    activeRecordId: null,
    updatedAt: null,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isConfig(value: unknown): value is AppConfig {
  if (!isObject(value)) return false;
  const investor = value.investor;
  const founder = value.founder;
  return isObject(investor) && investor.role === "investor" && isObject(investor.prompts) && isObject(investor.fields)
    && isObject(founder) && founder.role === "founder" && isObject(founder.prompts) && isObject(founder.fields)
    && isObject(value.settings);
}

function isVersion(value: unknown): value is SavedVersion {
  return isObject(value) && typeof value.id === "string" && value.id.length <= 200
    && typeof value.name === "string" && value.name.length <= 200
    && typeof value.createdAt === "string" && isConfig(value.config);
}

function isSimulationRecord(value: unknown): value is SimulationRecord {
  return isObject(value) && typeof value.conversationId === "string" && value.conversationId.length <= 200
    && typeof value.createdAt === "string" && Array.isArray(value.messages) && Array.isArray(value.debugCalls)
    && isObject(value.results);
}

function isRolePair(value: unknown): value is { investor: unknown | null; founder: unknown | null } {
  return isObject(value) && Object.hasOwn(value, "investor") && Object.hasOwn(value, "founder");
}

function isNullableId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length <= 200);
}

function normalizeStoredState(value: unknown): WorkspaceState {
  const fallback = defaultState();
  if (!isObject(value)) return fallback;
  return {
    schemaVersion: 1,
    config: isConfig(value.config) ? clone(value.config) : fallback.config,
    versions: Array.isArray(value.versions) ? value.versions.filter(isVersion).slice(0, MAX_VERSIONS) : [],
    records: Array.isArray(value.records) ? value.records.filter(isSimulationRecord).slice(0, MAX_RECORDS) : [],
    memories: isRolePair(value.memories) ? clone(value.memories) : fallback.memories,
    dailyReports: isRolePair(value.dailyReports) ? clone(value.dailyReports) : fallback.dailyReports,
    activeVersion: isNullableId(value.activeVersion) ? value.activeVersion : null,
    activeRecordId: isNullableId(value.activeRecordId) ? value.activeRecordId : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

function readState(database: DatabaseSync): WorkspaceState {
  const row = database.prepare("SELECT state_json FROM workspace_state WHERE id = 1").get() as { state_json: string } | undefined;
  if (!row) return defaultState();
  try {
    return normalizeStoredState(JSON.parse(row.state_json));
  } catch {
    return defaultState();
  }
}

function nextRevision(previous: string | null): string {
  const now = Date.now();
  const previousMs = previous ? Date.parse(previous) : Number.NaN;
  return new Date(Number.isFinite(previousMs) && now <= previousMs ? previousMs + 1 : now).toISOString();
}

export function getWorkspaceState(): WorkspaceState {
  return readState(db());
}

export function validateWorkspacePatch(value: unknown): WorkspaceStatePatch {
  if (!isObject(value)) throw new Error("请求体必须是 JSON 对象。");
  const allowed = new Set(["config", "versions", "records", "memories", "dailyReports", "activeVersion", "activeRecordId"]);
  const unknownKeys = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknownKeys.length) throw new Error(`不支持的字段：${unknownKeys.join("、")}。`);
  if (!Object.keys(value).length) throw new Error("至少提供一个需要保存的字段。");

  const patch: WorkspaceStatePatch = {};
  if (Object.hasOwn(value, "config")) {
    if (!isConfig(value.config)) throw new Error("config 结构无效。");
    patch.config = clone(value.config);
  }
  if (Object.hasOwn(value, "versions")) {
    if (!Array.isArray(value.versions) || value.versions.length > MAX_VERSIONS || !value.versions.every(isVersion)) {
      throw new Error(`versions 必须是有效数组且不能超过 ${MAX_VERSIONS} 条。`);
    }
    patch.versions = clone(value.versions);
  }
  if (Object.hasOwn(value, "records")) {
    if (!Array.isArray(value.records) || value.records.length > MAX_RECORDS || !value.records.every(isSimulationRecord)) {
      throw new Error(`records 必须是有效数组且不能超过 ${MAX_RECORDS} 条。`);
    }
    patch.records = clone(value.records);
  }
  if (Object.hasOwn(value, "memories")) {
    if (!isRolePair(value.memories)) throw new Error("memories 必须同时包含 investor 和 founder。");
    patch.memories = clone(value.memories);
  }
  if (Object.hasOwn(value, "dailyReports")) {
    if (!isRolePair(value.dailyReports)) throw new Error("dailyReports 必须同时包含 investor 和 founder。");
    patch.dailyReports = clone(value.dailyReports);
  }
  if (Object.hasOwn(value, "activeVersion")) {
    if (!isNullableId(value.activeVersion)) throw new Error("activeVersion 必须是字符串或 null。");
    patch.activeVersion = value.activeVersion;
  }
  if (Object.hasOwn(value, "activeRecordId")) {
    if (!isNullableId(value.activeRecordId)) throw new Error("activeRecordId 必须是字符串或 null。");
    patch.activeRecordId = value.activeRecordId;
  }
  if (JSON.stringify(patch).length > MAX_STATE_CHARS) throw new Error("保存内容过大。");
  return patch;
}

export function saveWorkspaceState(patch: WorkspaceStatePatch, expectedUpdatedAt: string | null): WorkspaceState {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    const current = readState(database);
    if (current.updatedAt !== expectedUpdatedAt) throw new WorkspaceStateConflictError(current);
    const next: WorkspaceState = {
      ...current,
      ...clone(patch),
      schemaVersion: 1,
      // `updatedAt` also acts as the optimistic-concurrency revision. Keep it
      // strictly monotonic even when two writes land in the same millisecond.
      updatedAt: nextRevision(current.updatedAt),
    };
    const serialized = JSON.stringify(next);
    if (serialized.length > MAX_STATE_CHARS) throw new Error("工作区总数据超过 24MB，请删除部分历史记录后重试。");
    database.prepare(`INSERT INTO workspace_state (id, state_json, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`)
      .run(serialized, next.updatedAt);
    database.exec("COMMIT");
    return next;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
