import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { buildCanonicalAgentCard, DEFAULT_CONFIG, deepCloneConfig, isAgentCardField } from "./defaults";
import type {
  AgentFileRecord,
  AgentProfile,
  AppConfig,
  DebugCall,
  DemoAgentCard,
  DirectChatMessage,
  DirectChatRoleState,
  DirectChatState,
  DirectChatThread,
  RunSettings,
  SavedVersion,
  SimulationRecord,
  ToolExecutionTrace,
  WorkspaceState,
  WorkspaceStatePatch,
} from "./types";

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "app.db");
const MAX_STATE_CHARS = 24_000_000;
const MAX_VERSIONS = 100;
const MAX_RECORDS = 20;
const MAX_DIRECT_CHAT_THREADS_PER_ROLE = 20;

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

function emptyDirectChats(): DirectChatState {
  return {
    investor: { activeThreadId: null, threads: [] },
    founder: { activeThreadId: null, threads: [] },
  };
}

function defaultState(): WorkspaceState {
  return {
    schemaVersion: 1,
    config: deepCloneConfig(DEFAULT_CONFIG),
    versions: [],
    records: [],
    directChats: emptyDirectChats(),
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

function isAgentRole(value: unknown): value is "investor" | "founder" {
  return value === "investor" || value === "founder";
}

function otherAgentRole(role: "investor" | "founder"): "investor" | "founder" {
  return role === "investor" ? "founder" : "investor";
}

function isShortString(value: unknown, maxLength = 200): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((item) => typeof item === "string");
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return isObject(value) && Object.values(value).every((item) => typeof item === "boolean");
}

function isAgentProfile(value: unknown, expectedRole?: "investor" | "founder"): value is AgentProfile {
  if (!isObject(value) || !isShortString(value.id) || !isAgentRole(value.role) || (expectedRole && value.role !== expectedRole)
    || !isStringRecord(value.fields) || !isObject(value.prompts)) return false;
  const prompts = value.prompts;
  return ["platform", "tools", "user", "task", "dynamic"].every((key) => {
    const layer = prompts[key];
    return isObject(layer) && typeof layer.enabled === "boolean" && typeof layer.content === "string"
      && Array.isArray(layer.variants) && layer.variants.every((variant) => isObject(variant)
        && isShortString(variant.id) && isShortString(variant.name) && typeof variant.content === "string"
        && typeof variant.createdAt === "string");
  });
}

function isRunSettings(value: unknown): value is RunSettings {
  return isObject(value) && isFiniteNonNegative(value.maxRounds) && isAgentRole(value.firstSpeaker)
    && isFiniteNonNegative(value.maxTokens) && typeof value.allowEarlyEnd === "boolean"
    && typeof value.generatePublicResult === "boolean" && typeof value.generateMemories === "boolean"
    && isFiniteNonNegative(value.inputPricePerMillion) && isFiniteNonNegative(value.outputPricePerMillion);
}

function isAgentFileRecord(value: unknown, expectedRole?: "investor" | "founder"): value is AgentFileRecord {
  return isObject(value) && isShortString(value.id) && isAgentRole(value.agentRole)
    && (!expectedRole || value.agentRole === expectedRole)
    && isShortString(value.originalName, 2_000) && isShortString(value.mimeType, 500)
    && isFiniteNonNegative(value.size) && isShortString(value.sha256, 200)
    && (value.status === "processing" || value.status === "ready" || value.status === "error")
    && (value.error === null || typeof value.error === "string")
    && isFiniteNonNegative(value.extractedChars) && isFiniteNonNegative(value.chunkCount)
    && typeof value.createdAt === "string";
}

function isToolExecutionTrace(value: unknown): value is ToolExecutionTrace {
  if (!isObject(value) || value.tool !== "search_private_files" || !isAgentRole(value.agentRole)
    || typeof value.query !== "string" || !isFiniteNonNegative(value.topK) || !isFiniteNonNegative(value.durationMs)
    || !Array.isArray(value.results) || (value.error !== null && typeof value.error !== "string")) return false;
  return value.results.every((result) => isObject(result) && isShortString(result.fileId)
    && isShortString(result.fileName, 2_000) && isShortString(result.chunkId)
    && typeof result.location === "string" && typeof result.content === "string"
    && typeof result.score === "number" && Number.isFinite(result.score));
}

const DEBUG_CALL_TYPES = new Set([
  "investor_turn", "founder_turn", "public_evaluation", "investor_memory", "founder_memory",
  "investor_daily_report", "founder_daily_report", "investor_direct_chat", "founder_direct_chat", "json_repair",
]);

function isDebugCall(value: unknown): value is DebugCall {
  return isObject(value) && isShortString(value.id) && DEBUG_CALL_TYPES.has(String(value.type))
    && (value.actor === "investor" || value.actor === "founder" || value.actor === "evaluator" || value.actor === "system")
    && (value.round === null || isFiniteNonNegative(value.round)) && typeof value.systemPrompt === "string"
    && isBooleanRecord(value.layerStates)
    && (value.profileSnapshot === null || isStringRecord(value.profileSnapshot))
    && Array.isArray(value.messages) && value.messages.every((message) => isObject(message)
      && typeof message.role === "string" && typeof message.content === "string")
    && typeof value.rawResponse === "string" && typeof value.startedAt === "string" && typeof value.endedAt === "string"
    && isFiniteNonNegative(value.durationMs) && isFiniteNonNegative(value.inputTokens)
    && isFiniteNonNegative(value.outputTokens) && isFiniteNonNegative(value.totalTokens)
    && typeof value.usageEstimated === "boolean" && isFiniteNonNegative(value.estimatedCost)
    && typeof value.success === "boolean" && (value.error === null || typeof value.error === "string")
    && (value.toolCalls === undefined || (Array.isArray(value.toolCalls) && value.toolCalls.every(isToolExecutionTrace)));
}

function isDemoAgentCard(value: unknown, expectedRole?: "investor" | "founder"): value is DemoAgentCard {
  if (!isObject(value) || !isShortString(value.agentId) || !isObject(value.publicIdentity)
    || !isAgentRole(value.publicIdentity.role)
    || (expectedRole && value.publicIdentity.role !== expectedRole) || !isStringRecord(value.publicIdentity.claims)) return false;
  const role = value.publicIdentity.role;
  const claims = value.publicIdentity.claims;
  if (!Object.keys(claims).every((key) => isAgentCardField(role, key))) return false;
  const canonicalCard = buildCanonicalAgentCard(value.agentId, role, claims);
  if (isDeepStrictEqual(value, canonicalCard)) return true;
  if (role !== "founder") return false;
  const legacyDescription = `${claims.company ? `${claims.company}的` : ""}创业者数字分身，用于非约束性的项目介绍与融资初步沟通${claims.oneLiner ? `；${claims.oneLiner}` : ""}。`;
  return isDeepStrictEqual(value, { ...canonicalCard, description: legacyDescription });
}

function isAgentCardPair(value: unknown): value is Record<"investor" | "founder", DemoAgentCard> {
  return isObject(value) && Object.keys(value).every((key) => key === "investor" || key === "founder")
    && isDemoAgentCard(value.investor, "investor") && isDemoAgentCard(value.founder, "founder");
}

function isDirectChatMessage(value: unknown): value is DirectChatMessage {
  return isObject(value) && isShortString(value.id) && (value.role === "user" || value.role === "assistant")
    && typeof value.content === "string" && typeof value.createdAt === "string" && isNullableId(value.callId)
    && isFiniteNonNegative(value.inputTokens) && isFiniteNonNegative(value.outputTokens)
    && typeof value.usageEstimated === "boolean" && isFiniteNonNegative(value.estimatedCost)
    && Array.isArray(value.toolCalls) && value.toolCalls.every(isToolExecutionTrace);
}

function isDirectChatThread(value: unknown, expectedRole: "investor" | "founder"): value is DirectChatThread {
  return isObject(value) && isShortString(value.id) && value.agentRole === expectedRole
    && typeof value.createdAt === "string" && typeof value.updatedAt === "string"
    && isAgentProfile(value.agentSnapshot, expectedRole) && isRunSettings(value.settingsSnapshot)
    && typeof value.promptSnapshot === "string" && typeof value.jsonRepairPromptSnapshot === "string"
    && isDemoAgentCard(value.counterpartyAgentCardSnapshot, otherAgentRole(expectedRole))
    && Array.isArray(value.fileSnapshots) && value.fileSnapshots.length <= 20
    && value.fileSnapshots.every((file) => isAgentFileRecord(file, expectedRole))
    && Array.isArray(value.messages) && value.messages.every(isDirectChatMessage)
    && Array.isArray(value.debugCalls) && value.debugCalls.every(isDebugCall)
    && Array.isArray(value.errors) && value.errors.every((item) => typeof item === "string");
}

function isDirectChatRoleState(value: unknown, role: "investor" | "founder"): value is DirectChatRoleState {
  if (!isObject(value) || !isNullableId(value.activeThreadId) || !Array.isArray(value.threads)
    || value.threads.length > MAX_DIRECT_CHAT_THREADS_PER_ROLE || !value.threads.every((thread) => isDirectChatThread(thread, role))) return false;
  const ids = value.threads.map((thread) => thread.id);
  return new Set(ids).size === ids.length && (value.activeThreadId === null || ids.includes(value.activeThreadId));
}

function isDirectChatState(value: unknown): value is DirectChatState {
  return isObject(value) && Object.keys(value).every((key) => key === "investor" || key === "founder")
    && isDirectChatRoleState(value.investor, "investor") && isDirectChatRoleState(value.founder, "founder");
}

function normalizeDirectChatRoleState(value: unknown, role: "investor" | "founder"): DirectChatRoleState {
  if (!isObject(value) || !Array.isArray(value.threads)) return { activeThreadId: null, threads: [] };
  const seen = new Set<string>();
  const threads = value.threads.flatMap((thread) => {
    if (!isDirectChatThread(thread, role) || seen.has(thread.id)) return [];
    seen.add(thread.id);
    return [clone(thread)];
  }).slice(0, MAX_DIRECT_CHAT_THREADS_PER_ROLE);
  const activeThreadId = isNullableId(value.activeThreadId) && value.activeThreadId !== null
    && threads.some((thread) => thread.id === value.activeThreadId) ? value.activeThreadId : null;
  return { activeThreadId, threads };
}

function normalizeDirectChats(value: unknown): DirectChatState {
  if (!isObject(value)) return emptyDirectChats();
  return {
    investor: normalizeDirectChatRoleState(value.investor, "investor"),
    founder: normalizeDirectChatRoleState(value.founder, "founder"),
  };
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
    && isObject(value.results)
    // `agentCardSnapshots` was added after the first persisted record format.
    // Missing snapshots remain valid so the client migration can generate them.
    && (!Object.hasOwn(value, "agentCardSnapshots") || isAgentCardPair(value.agentCardSnapshots));
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
    directChats: normalizeDirectChats(value.directChats),
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
  const allowed = new Set(["config", "versions", "records", "directChats", "memories", "dailyReports", "activeVersion", "activeRecordId"]);
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
  if (Object.hasOwn(value, "directChats")) {
    if (!isDirectChatState(value.directChats)) {
      throw new Error(`directChats 结构无效，且每个角色不能超过 ${MAX_DIRECT_CHAT_THREADS_PER_ROLE} 个对话。`);
    }
    patch.directChats = clone(value.directChats);
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
