import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { attachPresetDemoFileIds } from "./demo-file-links";
import {
  buildCanonicalAgentCard,
  DEFAULT_CONFIG,
  deepCloneConfig,
  deepCloneUserProfiles,
  isAgentCardField,
} from "./defaults";
import type {
  AgentFileRecord,
  AgentProfile,
  AgentRole,
  AppConfig,
  DebugCall,
  DemoAgentCard,
  DirectChatMessage,
  DirectChatRoleState,
  DirectChatState,
  DirectChatThread,
  PromptLayer,
  RunSettings,
  SavedVersion,
  SimulationRecord,
  ToolExecutionTrace,
  UserProfileLibrary,
  UserProfileRecord,
  WorkspaceState,
  WorkspaceStatePatch,
} from "./types";

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "app.db");
const MAX_STATE_CHARS = 24_000_000;
const MAX_VERSIONS = 100;
const MAX_RECORDS = 20;
const MAX_DIRECT_CHAT_THREADS_PER_ROLE = 20;
const MAX_USER_PROFILES_PER_ROLE = 20;
const MAX_PROFILE_FIELDS = 100;
const MAX_PROFILE_FIELD_VALUE_CHARS = 20_000;
const MAX_PROFILE_JSON_CHARS = 2_000_000;
const MIGRATION_TIMESTAMP = "2026-07-12T00:00:00.000Z";

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
    profiles: deepCloneUserProfiles(),
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

function isNonEmptyShortString(value: unknown, maxLength = 200): value is string {
  return isShortString(value, maxLength) && value.trim().length > 0 && !value.includes("\0");
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isProfileFields(value: unknown): value is Record<string, string> {
  if (!isObject(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > MAX_PROFILE_FIELDS) return false;
  return entries.every(([key, fieldValue]) => /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(key)
    && typeof fieldValue === "string" && fieldValue.length <= MAX_PROFILE_FIELD_VALUE_CHARS
    && !fieldValue.includes("\0"));
}

function isProfilePromptLayer(value: unknown): value is PromptLayer {
  if (!isObject(value) || Object.keys(value).some((key) => !["enabled", "content", "variants"].includes(key))
    || typeof value.enabled !== "boolean" || typeof value.content !== "string"
    || value.content.length > 200_000 || !Array.isArray(value.variants) || value.variants.length > 100) return false;
  const variantIds = new Set<string>();
  return value.variants.every((variant) => {
    if (!isObject(variant) || Object.keys(variant).some((key) => !["id", "name", "content", "createdAt"].includes(key))
      || !isNonEmptyShortString(variant.id) || variantIds.has(variant.id)
      || !isNonEmptyShortString(variant.name) || typeof variant.content !== "string"
      || variant.content.length > 200_000 || !isIsoTimestamp(variant.createdAt)) return false;
    variantIds.add(variant.id);
    return true;
  });
}

function isJsonData(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 100 || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonData(item, seen, depth + 1))
    : Object.entries(value).every(([key, item]) => key.length <= 500 && !key.includes("\0")
      && isJsonData(item, seen, depth + 1));
  seen.delete(value);
  return valid;
}

function isProfileJson(value: unknown): boolean {
  if (!isJsonData(value)) return false;
  try {
    return JSON.stringify(value).length <= MAX_PROFILE_JSON_CHARS;
  } catch {
    return false;
  }
}

function isUserProfileRecord(value: unknown, expectedRole: "investor" | "founder"): value is UserProfileRecord {
  const allowedKeys = new Set([
    "id", "role", "name", "kind", "fields", "dynamicLayer", "fileIds", "memory", "dailyReport", "createdAt", "updatedAt",
  ]);
  if (!isObject(value) || Object.keys(value).length !== allowedKeys.size
    || Object.keys(value).some((key) => !allowedKeys.has(key))
    || !isNonEmptyShortString(value.id) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.id)
    || value.role !== expectedRole || !isNonEmptyShortString(value.name) || value.name.trim() !== value.name
    || (value.kind !== "preset" && value.kind !== "custom") || !isProfileFields(value.fields)
    || !isProfilePromptLayer(value.dynamicLayer) || !Array.isArray(value.fileIds)
    || value.fileIds.length > 20 || !isProfileJson(value.memory) || !isProfileJson(value.dailyReport)
    || !isIsoTimestamp(value.createdAt) || !isIsoTimestamp(value.updatedAt)
    || Date.parse(value.createdAt) > Date.parse(value.updatedAt)) return false;
  const fileIds = value.fileIds;
  return fileIds.every((fileId) => isNonEmptyShortString(fileId) && fileId.trim() === fileId)
    && new Set(fileIds).size === fileIds.length;
}

function isUserProfileLibrary(value: unknown, enforceExclusiveFiles = true): value is UserProfileLibrary {
  if (!isObject(value) || Object.keys(value).length !== 2
    || !Object.hasOwn(value, "investor") || !Object.hasOwn(value, "founder")
    || !Array.isArray(value.investor) || !Array.isArray(value.founder)
    || value.investor.length < 1 || value.investor.length > MAX_USER_PROFILES_PER_ROLE
    || value.founder.length < 1 || value.founder.length > MAX_USER_PROFILES_PER_ROLE
    || !value.investor.every((profile) => isUserProfileRecord(profile, "investor"))
    || !value.founder.every((profile) => isUserProfileRecord(profile, "founder"))) return false;
  const ids = [...value.investor, ...value.founder].map((profile) => profile.id);
  if (new Set(ids).size !== ids.length) return false;
  if (!enforceExclusiveFiles) return true;
  const profilesByRole = value as unknown as UserProfileLibrary;
  return (["investor", "founder"] as const).every((role) => {
    const fileIds = profilesByRole[role].flatMap((profile) => profile.fileIds);
    return new Set(fileIds).size === fileIds.length;
  });
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return isObject(value) && Object.values(value).every((item) => typeof item === "boolean");
}

function isAgentProfile(value: unknown, expectedRole?: "investor" | "founder"): value is AgentProfile {
  if (!isObject(value) || Object.keys(value).some((key) => !["id", "role", "fields", "prompts"].includes(key))
    || !isNonEmptyShortString(value.id) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.id)
    || !isAgentRole(value.role) || (expectedRole && value.role !== expectedRole)
    || !isProfileFields(value.fields) || !isObject(value.prompts)
    || Object.keys(value.prompts).length !== 5) return false;
  const prompts = value.prompts;
  return ["platform", "tools", "user", "task", "dynamic"].every((key) => isProfilePromptLayer(prompts[key]));
}

function isRunSettings(value: unknown): value is RunSettings {
  const keys = ["maxRounds", "firstSpeaker", "maxTokens", "allowEarlyEnd", "generatePublicResult", "generateMemories", "inputPricePerMillion", "outputPricePerMillion"];
  return isObject(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key))
    && Number.isInteger(value.maxRounds) && Number(value.maxRounds) >= 1 && Number(value.maxRounds) <= 20 && isAgentRole(value.firstSpeaker)
    && Number.isInteger(value.maxTokens) && Number(value.maxTokens) >= 64 && Number(value.maxTokens) <= 16_000
    && typeof value.allowEarlyEnd === "boolean"
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
    && (!Object.hasOwn(value, "counterpartyAgentCardSnapshot")
      || isDemoAgentCard(value.counterpartyAgentCardSnapshot, otherAgentRole(expectedRole)))
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
    // Older user-test threads were created under the former peer-Card design.
    // Do not expose or continue those histories after switching this feature to
    // a user talking only with their own Agent; their debug calls may contain a
    // frozen counterparty Card and therefore cannot be safely reinterpreted.
    if (Object.hasOwn(thread, "counterpartyAgentCardSnapshot")) return [];
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

function isStoredConfig(value: unknown): value is AppConfig {
  if (!isObject(value)) return false;
  const investor = value.investor;
  const founder = value.founder;
  return isObject(investor) && isNonEmptyShortString(investor.id) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(investor.id)
    && investor.role === "investor" && isObject(investor.prompts) && isObject(investor.fields)
    && isObject(founder) && isNonEmptyShortString(founder.id) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(founder.id)
    && founder.role === "founder" && isObject(founder.prompts) && isObject(founder.fields)
    && isObject(value.settings);
}

function isStrictConfig(value: unknown): value is AppConfig {
  const keys = ["investor", "founder", "settings", "evaluatorPrompt", "memoryPrompts", "jsonRepairPrompt", "dailyReport"];
  if (!isObject(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))
    || !isAgentProfile(value.investor, "investor") || !isAgentProfile(value.founder, "founder")
    || value.investor.id === value.founder.id || !isRunSettings(value.settings)
    || typeof value.evaluatorPrompt !== "string" || value.evaluatorPrompt.length > 200_000
    || typeof value.jsonRepairPrompt !== "string" || value.jsonRepairPrompt.length > 200_000
    || !isObject(value.memoryPrompts) || Object.keys(value.memoryPrompts).length !== 2
    || typeof value.memoryPrompts.investor !== "string" || value.memoryPrompts.investor.length > 200_000
    || typeof value.memoryPrompts.founder !== "string" || value.memoryPrompts.founder.length > 200_000
    || !isObject(value.dailyReport) || Object.keys(value.dailyReport).length !== 2) return false;
  const dailyReport = value.dailyReport as Record<AgentRole, unknown>;
  return (["investor", "founder"] as const).every((role) => {
    const report = dailyReport[role];
    return isObject(report) && Object.keys(report).length === 5
      && Object.keys(report).every((key) => ["taskPrompt", "dynamicPrompt", "taskVariants", "dynamicVariants", "maxTokens"].includes(key))
      && typeof report.taskPrompt === "string" && typeof report.dynamicPrompt === "string"
      && isProfilePromptLayer({ enabled: true, content: report.taskPrompt, variants: report.taskVariants })
      && isProfilePromptLayer({ enabled: true, content: report.dynamicPrompt, variants: report.dynamicVariants })
      && Number.isInteger(report.maxTokens) && Number(report.maxTokens) >= 64 && Number(report.maxTokens) <= 16_000;
  });
}

function migrationTimestamp(value: unknown): string {
  return isIsoTimestamp(value) ? value : MIGRATION_TIMESTAMP;
}

function profileDisplayName(role: "investor" | "founder", fields: Record<string, string>, recovered: boolean): string {
  const fallback = role === "investor" ? "投资人资料" : "创业者资料";
  const source = fields.agentName?.trim() || fields.organization?.trim() || fields.company?.trim() || fallback;
  const name = recovered ? `已恢复 · ${source}` : source;
  return name.slice(0, 200);
}

function profileJsonOrNull(value: unknown): unknown | null {
  return isProfileJson(value) ? clone(value) : null;
}

function profileFromConfig(
  config: AppConfig,
  role: "investor" | "founder",
  memory: unknown,
  dailyReport: unknown,
  timestamp: string,
  recovered: boolean,
): UserProfileRecord {
  const current = config[role];
  const defaultProfile = deepCloneUserProfiles()[role][0];
  const fields = isProfileFields(current.fields) ? clone(current.fields) : defaultProfile.fields;
  const dynamicLayer = isProfilePromptLayer(current.prompts.dynamic)
    ? clone(current.prompts.dynamic)
    : defaultProfile.dynamicLayer;
  return {
    id: current.id,
    role,
    name: profileDisplayName(role, fields, recovered),
    kind: "custom",
    fields,
    dynamicLayer,
    fileIds: [],
    memory: profileJsonOrNull(memory),
    dailyReport: profileJsonOrNull(dailyReport),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function migrateMissingProfiles(
  config: AppConfig,
  memories: unknown,
  dailyReports: unknown,
  timestamp: string,
): UserProfileLibrary {
  const profiles = deepCloneUserProfiles();
  (["investor", "founder"] as const).forEach((role) => {
    const memory = isRolePair(memories) ? memories[role] : null;
    const dailyReport = isRolePair(dailyReports) ? dailyReports[role] : null;
    const presetIndex = profiles[role].findIndex((profile) => profile.id === config[role].id);
    if (presetIndex >= 0) {
      const preset = profiles[role][presetIndex];
      const fields = isProfileFields(config[role].fields) ? clone(config[role].fields) : preset.fields;
      profiles[role][presetIndex] = {
        ...preset,
        fields,
        dynamicLayer: isProfilePromptLayer(config[role].prompts.dynamic)
          ? clone(config[role].prompts.dynamic)
          : preset.dynamicLayer,
        memory: profileJsonOrNull(memory),
        dailyReport: profileJsonOrNull(dailyReport),
        updatedAt: timestamp,
      };
      return;
    }
    profiles[role] = [
      profileFromConfig(config, role, memory, dailyReport, timestamp, false),
      ...profiles[role],
    ];
  });
  return profiles;
}

function listReadyAgentFileIds(): Set<string> {
  try {
    const rows = db().prepare("SELECT id FROM agent_files WHERE status = 'ready'").all() as Array<{ id: string }>;
    return new Set(rows.map((row) => String(row.id)));
  } catch {
    return new Set();
  }
}

function normalizeProfiles(
  value: unknown,
  config: AppConfig,
  memories: unknown,
  dailyReports: unknown,
  updatedAt: unknown,
): UserProfileLibrary {
  const timestamp = migrationTimestamp(updatedAt);
  if (!isUserProfileLibrary(value, false)) {
    return attachPresetDemoFileIds(
      migrateMissingProfiles(config, memories, dailyReports, timestamp),
      listReadyAgentFileIds(),
      timestamp,
    );
  }
  const profiles = clone(value);
  (["investor", "founder"] as const).forEach((role) => {
    const seenFileIds = new Set<string>();
    profiles[role] = profiles[role].map((profile) => {
      const fileIds = profile.fileIds.filter((fileId) => {
        if (seenFileIds.has(fileId)) return false;
        seenFileIds.add(fileId);
        return true;
      });
      return fileIds.length === profile.fileIds.length ? profile : { ...profile, fileIds, updatedAt: timestamp };
    });
  });
  (["investor", "founder"] as const).forEach((role) => {
    if (profiles[role].some((profile) => profile.id === config[role].id)) return;
    const memory = isRolePair(memories) ? memories[role] : null;
    const dailyReport = isRolePair(dailyReports) ? dailyReports[role] : null;
    profiles[role] = [
      profileFromConfig(config, role, memory, dailyReport, timestamp, true),
      ...profiles[role].slice(0, MAX_USER_PROFILES_PER_ROLE - 1),
    ];
  });
  // The persisted library was valid before recovery. A conflicting legacy ID
  // across roles is not representable as two Agent IDs, so fall back to the
  // deterministic migration instead of returning an invalid state.
  const resolved = isUserProfileLibrary(profiles)
    ? profiles
    : migrateMissingProfiles(config, memories, dailyReports, timestamp);
  return attachPresetDemoFileIds(resolved, listReadyAgentFileIds(), timestamp);
}

function isStoredVersion(value: unknown): value is SavedVersion {
  return isObject(value) && typeof value.id === "string" && value.id.length <= 200
    && typeof value.name === "string" && value.name.length <= 200
    && typeof value.createdAt === "string" && isStoredConfig(value.config);
}

function isStrictVersion(value: unknown): value is SavedVersion {
  return isObject(value) && isNonEmptyShortString(value.id) && isNonEmptyShortString(value.name)
    && isIsoTimestamp(value.createdAt) && isStrictConfig(value.config);
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
  const config = isStoredConfig(value.config) ? clone(value.config) : fallback.config;
  const memories = isRolePair(value.memories) ? clone(value.memories) : fallback.memories;
  const dailyReports = isRolePair(value.dailyReports) ? clone(value.dailyReports) : fallback.dailyReports;
  return {
    schemaVersion: 1,
    config,
    profiles: normalizeProfiles(value.profiles, config, memories, dailyReports, value.updatedAt),
    versions: Array.isArray(value.versions) ? value.versions.filter(isStoredVersion).slice(0, MAX_VERSIONS) : [],
    records: Array.isArray(value.records) ? value.records.filter(isSimulationRecord).slice(0, MAX_RECORDS) : [],
    directChats: normalizeDirectChats(value.directChats),
    memories,
    dailyReports,
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
  const allowed = new Set(["config", "profiles", "versions", "records", "directChats", "memories", "dailyReports", "activeVersion", "activeRecordId"]);
  const unknownKeys = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknownKeys.length) throw new Error(`不支持的字段：${unknownKeys.join("、")}。`);
  if (!Object.keys(value).length) throw new Error("至少提供一个需要保存的字段。");

  const patch: WorkspaceStatePatch = {};
  if (Object.hasOwn(value, "config")) {
    if (!isStrictConfig(value.config)) throw new Error("config 结构无效。");
    patch.config = clone(value.config);
  }
  if (Object.hasOwn(value, "profiles")) {
    if (!isUserProfileLibrary(value.profiles)) {
      throw new Error(`profiles 结构无效；每个角色必须有 1–${MAX_USER_PROFILES_PER_ROLE} 套资料，且 Agent ID 必须唯一。`);
    }
    patch.profiles = clone(value.profiles);
  }
  if (Object.hasOwn(value, "versions")) {
    if (!Array.isArray(value.versions) || value.versions.length > MAX_VERSIONS || !value.versions.every(isStrictVersion)) {
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
    const revision = nextRevision(current.updatedAt);
    const merged = {
      ...current,
      ...clone(patch),
    };
    const profiles = normalizeProfiles(merged.profiles, merged.config, merged.memories, merged.dailyReports, revision);
    const config = clone(merged.config);
    (["investor", "founder"] as const).forEach((role) => {
      const profile = profiles[role].find((item) => item.id === config[role].id) || profiles[role][0];
      config[role] = {
        ...config[role],
        id: profile.id,
        fields: clone(profile.fields),
        prompts: { ...config[role].prompts, dynamic: clone(profile.dynamicLayer) },
      };
    });
    const activeInvestor = profiles.investor.find((profile) => profile.id === config.investor.id) || profiles.investor[0];
    const activeFounder = profiles.founder.find((profile) => profile.id === config.founder.id) || profiles.founder[0];
    const next: WorkspaceState = {
      ...merged,
      schemaVersion: 1,
      config,
      profiles,
      directChats: normalizeDirectChats(merged.directChats),
      memories: { investor: clone(activeInvestor.memory), founder: clone(activeFounder.memory) },
      dailyReports: { investor: clone(activeInvestor.dailyReport), founder: clone(activeFounder.dailyReport) },
      // `updatedAt` also acts as the optimistic-concurrency revision. Keep it
      // strictly monotonic even when two writes land in the same millisecond.
      updatedAt: revision,
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
