"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_CONFIG,
  FIELD_DEFINITIONS,
  LAYER_LABELS,
  composeDailyPrompt,
  composeDirectChatPrompt,
  composeMemoryPrompt,
  composePrompt,
  deepCloneConfig,
  deepCloneUserProfiles,
  defaultLayer,
  buildAgentCard,
  formatPeerAgentCardMessage,
  formatProfile,
  isAgentCardField,
} from "@/lib/defaults";
import { attachPresetDemoFileIds } from "@/lib/demo-file-links";
import type {
  AgentProfile,
  AgentFileRecord,
  AgentRole,
  AppConfig,
  DebugCall,
  DemoAgentCard,
  DirectChatMessage,
  DirectChatRoleState,
  DirectChatState,
  DirectChatThread,
  LayerKey,
  FieldDefinition,
  PromptVariant,
  SavedVersion,
  SimulationRecord,
  TurnControl,
  TurnMessage,
  ToolExecutionTrace,
  UserProfileLibrary,
  UserProfileRecord,
  WorkspaceState,
  WorkspaceStatePatch,
} from "@/lib/types";
import { JsonReadableView, type JsonDisplayKind } from "@/lib/json-display";

const LEGACY_CONFIG_KEY = "vc-agent-debugger:config:v1";
const LEGACY_VERSION_KEY = "vc-agent-debugger:versions:v1";
const LEGACY_RECORD_KEY = "vc-agent-debugger:records:v1";
const LEGACY_STORAGE_KEYS = [LEGACY_CONFIG_KEY, LEGACY_VERSION_KEY, LEGACY_RECORD_KEY] as const;
const WORKSPACE_PATCH_KEYS = ["config", "profiles", "versions", "records", "memories", "dailyReports", "directChats", "activeVersion", "activeRecordId"] as const;
const ROLE_LABEL: Record<AgentRole, string> = { investor: "投资人", founder: "创业者" };

type RunStatus = "idle" | "running" | "paused" | "stopping" | "postprocessing" | "completed" | "error";
type TopTab = "conversation" | "results" | "daily" | "debug";
type SaveStatus = "loading" | "saved" | "saving" | "error";

function otherRole(role: AgentRole): AgentRole {
  return role === "investor" ? "founder" : "investor";
}

function emptyDirectChats(): DirectChatState {
  return {
    investor: { activeThreadId: null, threads: [] },
    founder: { activeThreadId: null, threads: [] },
  };
}

function activeUserProfile(library: UserProfileLibrary, config: AppConfig, role: AgentRole): UserProfileRecord {
  return library[role].find((profile) => profile.id === config[role].id) || library[role][0];
}

function userProfileFromAgent(
  agent: AgentProfile,
  name: string,
  kind: UserProfileRecord["kind"],
  memory: unknown | null = null,
  dailyReport: unknown | null = null,
  fileIds: string[] = [],
): UserProfileRecord {
  const now = new Date().toISOString();
  return {
    id: agent.id,
    role: agent.role,
    name: name.trim().slice(0, 200) || agent.fields.agentName || `${ROLE_LABEL[agent.role]}资料`,
    kind,
    fields: clone(agent.fields),
    dynamicLayer: clone(agent.prompts.dynamic),
    fileIds: [...new Set(fileIds)].slice(0, 20),
    memory: clone(memory),
    dailyReport: clone(dailyReport),
    createdAt: now,
    updatedAt: now,
  };
}

function syncProfilesWithConfig(
  library: UserProfileLibrary,
  config: AppConfig,
  memories: Record<AgentRole, unknown | null>,
  reports: Record<AgentRole, unknown | null>,
): UserProfileLibrary {
  const next = clone(library);
  (["investor", "founder"] as AgentRole[]).forEach((role) => {
    const index = next[role].findIndex((profile) => profile.id === config[role].id);
    if (index >= 0) return;
    const profile = userProfileFromAgent(
      config[role],
      `已恢复 · ${config[role].fields.agentName || ROLE_LABEL[role]}`,
      "custom",
      memories[role],
      reports[role],
    );
    next[role] = [profile, ...next[role]].slice(0, 20);
  });
  return next;
}

function migrateLegacyProfiles(
  library: UserProfileLibrary,
  config: AppConfig,
  memories: Record<AgentRole, unknown | null>,
  reports: Record<AgentRole, unknown | null>,
): UserProfileLibrary {
  const next = syncProfilesWithConfig(library, config, memories, reports);
  const now = new Date().toISOString();
  (["investor", "founder"] as AgentRole[]).forEach((role) => {
    const index = next[role].findIndex((profile) => profile.id === config[role].id);
    if (index < 0) return;
    next[role][index] = {
      ...next[role][index],
      fields: clone(config[role].fields),
      dynamicLayer: clone(config[role].prompts.dynamic),
      memory: clone(memories[role]),
      dailyReport: clone(reports[role]),
      updatedAt: now,
    };
  });
  return next;
}

function id(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

function profileFieldsKey(fields: Record<string, string>): string {
  const value = JSON.stringify(fields);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function nowMs() {
  return Date.now();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isConfigCandidate(value: unknown): value is AppConfig {
  if (!isPlainObject(value) || !isPlainObject(value.investor) || !isPlainObject(value.founder) || !isPlainObject(value.settings)) return false;
  const investor = value.investor;
  const founder = value.founder;
  return typeof investor.id === "string" && investor.role === "investor" && isPlainObject(investor.fields)
    && Object.values(investor.fields).every((field) => typeof field === "string") && isPlainObject(investor.prompts)
    && typeof founder.id === "string" && founder.role === "founder" && isPlainObject(founder.fields)
    && Object.values(founder.fields).every((field) => typeof field === "string") && isPlainObject(founder.prompts);
}

function normalizeLegacyVersions(value: unknown): { items: SavedVersion[]; discarded: number } {
  if (!Array.isArray(value)) throw new Error("旧配置版本不是数组");
  const items = value.flatMap((candidate) => {
    if (!isPlainObject(candidate)
      || typeof candidate.id !== "string" || !candidate.id.trim() || candidate.id.length > 200 || candidate.id.includes("\0")
      || typeof candidate.name !== "string" || !candidate.name.trim() || candidate.name.length > 200 || candidate.name.includes("\0")
      || typeof candidate.createdAt !== "string"
      || !isConfigCandidate(candidate.config)) return [];
    try {
      const createdAt = Number.isFinite(Date.parse(candidate.createdAt)) && new Date(Date.parse(candidate.createdAt)).toISOString() === candidate.createdAt
        ? candidate.createdAt
        : new Date().toISOString();
      return [{ id: candidate.id.trim(), name: candidate.name.trim(), createdAt, config: migrateConfig(candidate.config) }];
    } catch {
      return [];
    }
  }).slice(0, 100);
  return { items, discarded: value.length - items.length };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isLegacyTurnMessage(value: unknown): value is TurnMessage {
  if (!isPlainObject(value) || !isPlainObject(value.control)) return false;
  const allowedReasons = new Set([
    null, "max_rounds", "sufficient_information", "clear_match", "clear_mismatch", "explicit_rejection",
    "missing_critical_information", "safety_or_compliance", "manual_stop", "no_new_information",
  ]);
  return typeof value.id === "string"
    && (value.role === "investor" || value.role === "founder")
    && typeof value.agentName === "string" && isFiniteNumber(value.round) && typeof value.content === "string"
    && typeof value.control.suggest_end === "boolean" && allowedReasons.has(value.control.end_reason as string | null)
    && typeof value.control.information_sufficient === "boolean"
    && isFiniteNumber(value.durationMs) && isFiniteNumber(value.inputTokens) && isFiniteNumber(value.outputTokens)
    && typeof value.usageEstimated === "boolean" && isFiniteNumber(value.estimatedCost) && typeof value.createdAt === "string";
}

function isLegacyDebugCall(value: unknown): value is DebugCall {
  if (!isPlainObject(value) || !isPlainObject(value.layerStates) || !Array.isArray(value.messages)) return false;
  const callTypes = new Set(["investor_turn", "founder_turn", "public_evaluation", "investor_memory", "founder_memory", "investor_daily_report", "founder_daily_report", "investor_direct_chat", "founder_direct_chat", "json_repair"]);
  const actors = new Set(["investor", "founder", "evaluator", "system"]);
  const profileValid = value.profileSnapshot === null || (isPlainObject(value.profileSnapshot) && Object.values(value.profileSnapshot).every((item) => typeof item === "string"));
  return typeof value.id === "string" && callTypes.has(value.type as string) && actors.has(value.actor as string)
    && (value.round === null || isFiniteNumber(value.round)) && typeof value.systemPrompt === "string"
    && Object.values(value.layerStates).every((item) => typeof item === "boolean") && profileValid
    && value.messages.every((message) => isPlainObject(message) && typeof message.role === "string" && typeof message.content === "string")
    && typeof value.rawResponse === "string" && typeof value.startedAt === "string" && typeof value.endedAt === "string"
    && isFiniteNumber(value.durationMs) && isFiniteNumber(value.inputTokens) && isFiniteNumber(value.outputTokens)
    && isFiniteNumber(value.totalTokens) && typeof value.usageEstimated === "boolean" && isFiniteNumber(value.estimatedCost)
    && typeof value.success === "boolean" && (value.error === null || typeof value.error === "string")
    && (value.toolCalls === undefined || Array.isArray(value.toolCalls));
}

function isLegacyFileRecord(value: unknown): value is AgentFileRecord {
  return isPlainObject(value) && typeof value.id === "string" && (value.agentRole === "investor" || value.agentRole === "founder")
    && typeof value.originalName === "string" && typeof value.mimeType === "string" && isFiniteNumber(value.size)
    && typeof value.sha256 === "string" && (value.status === "processing" || value.status === "ready" || value.status === "error")
    && (value.error === null || typeof value.error === "string") && isFiniteNumber(value.extractedChars)
    && isFiniteNumber(value.chunkCount) && typeof value.createdAt === "string";
}

function isLegacyRawErrorMap(value: unknown): value is Record<string, { raw: string; error: string }> {
  return isPlainObject(value) && Object.values(value).every((entry) => isPlainObject(entry) && typeof entry.raw === "string" && typeof entry.error === "string");
}

function isDemoAgentCard(value: unknown, role?: AgentRole): value is DemoAgentCard {
  return isPlainObject(value) && value.format === "a2a-inspired" && value.referenceVersion === "1.0"
    && typeof value.agentId === "string" && typeof value.name === "string" && typeof value.description === "string"
    && typeof value.version === "string" && isPlainObject(value.capabilities)
    && Array.isArray(value.defaultInputModes) && Array.isArray(value.defaultOutputModes) && Array.isArray(value.skills)
    && isPlainObject(value.publicIdentity) && (value.publicIdentity.role === "investor" || value.publicIdentity.role === "founder")
    && (!role || value.publicIdentity.role === role) && isPlainObject(value.publicIdentity.claims)
    && Object.values(value.publicIdentity.claims).every((claim) => typeof claim === "string");
}

function isLegacyRecord(candidate: unknown): candidate is SimulationRecord {
  if (!isPlainObject(candidate)
    || typeof candidate.conversationId !== "string" || candidate.conversationId.length > 200
    || typeof candidate.createdAt !== "string"
    || (candidate.completedAt !== null && typeof candidate.completedAt !== "string")
    || (candidate.configVersion !== null && (typeof candidate.configVersion !== "string" || candidate.configVersion.length > 200))
    || !isConfigCandidate(candidate.configSnapshot)
    || !Array.isArray(candidate.messages) || !candidate.messages.every(isLegacyTurnMessage)
    || !Array.isArray(candidate.debugCalls) || !candidate.debugCalls.every(isLegacyDebugCall)
    || !Array.isArray(candidate.errors) || !candidate.errors.every((error) => typeof error === "string")
    || !isPlainObject(candidate.results) || !isPlainObject(candidate.results.dailyReports) || !isLegacyRawErrorMap(candidate.results.rawErrors)
    || !isPlainObject(candidate.promptSnapshots) || !isPlainObject(candidate.fileSnapshots) || !isPlainObject(candidate.memorySnapshots)
    || typeof candidate.promptSnapshots.investor !== "string" || typeof candidate.promptSnapshots.founder !== "string"
    || !Array.isArray(candidate.fileSnapshots.investor) || !candidate.fileSnapshots.investor.every(isLegacyFileRecord)
    || !Array.isArray(candidate.fileSnapshots.founder) || !candidate.fileSnapshots.founder.every(isLegacyFileRecord)
    || !Object.hasOwn(candidate.memorySnapshots, "investor") || !Object.hasOwn(candidate.memorySnapshots, "founder")
    || !Object.hasOwn(candidate.results.dailyReports, "investor") || !Object.hasOwn(candidate.results.dailyReports, "founder")
    || !isPlainObject(candidate.stats)
    || typeof candidate.stats.inputTokens !== "number" || typeof candidate.stats.outputTokens !== "number" || typeof candidate.stats.estimatedCost !== "number"
    || (candidate.endReason !== null && typeof candidate.endReason !== "string")) return false;
  return true;
}

function normalizeLegacyRecords(value: unknown): { items: SimulationRecord[]; discarded: number } {
  if (!Array.isArray(value)) throw new Error("旧模拟记录不是数组");
  const items = value.flatMap((record) => {
    if (!isLegacyRecord(record)) return [];
    try {
      const configSnapshot = migrateConfig(record.configSnapshot);
      const existingCards = isPlainObject(record.agentCardSnapshots)
        && isDemoAgentCard(record.agentCardSnapshots.investor, "investor")
        && isDemoAgentCard(record.agentCardSnapshots.founder, "founder")
        ? clone(record.agentCardSnapshots) as Record<AgentRole, DemoAgentCard>
        : { investor: buildAgentCard(configSnapshot.investor), founder: buildAgentCard(configSnapshot.founder) };
      return [{ ...clone(record), configSnapshot, agentCardSnapshots: existingCards }];
    } catch {
      return [];
    }
  }).slice(0, 20);
  return { items, discarded: value.length - items.length };
}

function serializedWorkspaceState(state: WorkspaceState): Record<string, string> {
  const stateRecord = state as unknown as Record<string, unknown>;
  return Object.fromEntries(WORKSPACE_PATCH_KEYS.map((key) => [key, JSON.stringify(stateRecord[key])]));
}

function normalizedVariants(value: unknown, label: string): PromptVariant[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((candidate, index) => {
    if (!isPlainObject(candidate) || typeof candidate.content !== "string") return [];
    let variantId = typeof candidate.id === "string" ? candidate.id.trim().slice(0, 200) : "";
    if (!variantId || variantId.includes("\0") || seen.has(variantId)) variantId = `variant-${crypto.randomUUID()}`;
    seen.add(variantId);
    const rawName = typeof candidate.name === "string" ? candidate.name.trim().slice(0, 200) : "";
    const rawCreatedAt = typeof candidate.createdAt === "string" ? candidate.createdAt : "";
    const createdAt = Number.isFinite(Date.parse(rawCreatedAt)) && new Date(Date.parse(rawCreatedAt)).toISOString() === rawCreatedAt
      ? rawCreatedAt
      : new Date().toISOString();
    return [{ id: variantId, name: rawName || `${label} ${index + 1}`, content: candidate.content.slice(0, 200_000), createdAt }];
  }).slice(0, 100);
}

function migrateConfig(value: AppConfig): AppConfig {
  const migrated = clone(value);
  const rawSettings: Record<string, unknown> = isPlainObject(migrated.settings) ? migrated.settings : {};
  const finiteNumber = (candidate: unknown, fallback: number) => typeof candidate === "number" && Number.isFinite(candidate) ? candidate : fallback;
  migrated.settings = {
    maxRounds: Math.min(20, Math.max(1, Math.round(finiteNumber(rawSettings.maxRounds, DEFAULT_CONFIG.settings.maxRounds)))),
    firstSpeaker: rawSettings.firstSpeaker === "founder" ? "founder" : "investor",
    maxTokens: Math.min(16000, Math.max(64, Math.round(finiteNumber(rawSettings.maxTokens, DEFAULT_CONFIG.settings.maxTokens)))),
    allowEarlyEnd: typeof rawSettings.allowEarlyEnd === "boolean" ? rawSettings.allowEarlyEnd : DEFAULT_CONFIG.settings.allowEarlyEnd,
    generatePublicResult: typeof rawSettings.generatePublicResult === "boolean" ? rawSettings.generatePublicResult : DEFAULT_CONFIG.settings.generatePublicResult,
    generateMemories: typeof rawSettings.generateMemories === "boolean" ? rawSettings.generateMemories : DEFAULT_CONFIG.settings.generateMemories,
    inputPricePerMillion: Math.max(0, finiteNumber(rawSettings.inputPricePerMillion, DEFAULT_CONFIG.settings.inputPricePerMillion)),
    outputPricePerMillion: Math.max(0, finiteNumber(rawSettings.outputPricePerMillion, DEFAULT_CONFIG.settings.outputPricePerMillion)),
  };
  (["investor", "founder"] as AgentRole[]).forEach((role) => {
    if (!migrated[role]?.prompts || !migrated[role]?.fields) migrated[role] = clone(DEFAULT_CONFIG[role]);
    migrated[role].id = typeof migrated[role].id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(migrated[role].id)
      ? migrated[role].id
      : DEFAULT_CONFIG[role].id;
    migrated[role].role = role;
    migrated[role].fields = Object.fromEntries(Object.entries(migrated[role].fields)
      .filter((entry): entry is [string, string] => /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(entry[0]) && typeof entry[1] === "string")
      .slice(0, 100)
      .map(([key, fieldValue]) => [key, fieldValue.replaceAll("\0", "").slice(0, 20_000)]));
    (Object.keys(LAYER_LABELS) as LayerKey[]).forEach((key) => {
      const fallback = DEFAULT_CONFIG[role].prompts[key];
      const layer = migrated[role].prompts[key];
      migrated[role].prompts[key] = !layer || typeof layer !== "object"
        ? clone(fallback)
        : {
          enabled: typeof layer.enabled === "boolean" ? layer.enabled : fallback.enabled,
          content: (typeof layer.content === "string" ? layer.content : fallback.content).slice(0, 200_000),
          variants: normalizedVariants(layer.variants, `${LAYER_LABELS[key]}版本`),
        };
    });
    const toolLayer = migrated[role].prompts.tools;
    const isLegacyToolPrompt = (content: string) => content.startsWith("当前版本没有可用的外部工具。不得虚构已查询数据库");
    if (toolLayer?.content && isLegacyToolPrompt(toolLayer.content)) {
      toolLayer.content = DEFAULT_CONFIG[role].prompts.tools.content;
    }
    toolLayer.variants = toolLayer.variants.map((variant) => isLegacyToolPrompt(variant.content)
      ? { ...variant, content: DEFAULT_CONFIG[role].prompts.tools.content }
      : variant);
    const platformLayer = migrated[role].prompts.platform;
    const legacyRoleMarker = role === "investor" ? "角色附加要求：你是投资人数字分身" : "角色附加要求：你是创业者数字分身";
    const isLegacyPlatformPrompt = (content: string) => content.includes(legacyRoleMarker)
      || content.includes("4. 事实与证据：始终区分当前输入");
    if (platformLayer?.content && isLegacyPlatformPrompt(platformLayer.content)) {
      platformLayer.content = DEFAULT_CONFIG[role].prompts.platform.content;
    }
    platformLayer.variants = platformLayer.variants.map((variant) => isLegacyPlatformPrompt(variant.content)
      ? { ...variant, content: DEFAULT_CONFIG[role].prompts.platform.content }
      : variant);
    migrated[role].prompts.user.enabled = true;
    migrated[role].prompts.user.content = "";
  });
  if (typeof migrated.evaluatorPrompt !== "string" || !migrated.evaluatorPrompt) migrated.evaluatorPrompt = DEFAULT_CONFIG.evaluatorPrompt;
  else if (migrated.evaluatorPrompt.includes("双方公开资料")) migrated.evaluatorPrompt = migrated.evaluatorPrompt.replaceAll("双方公开资料", "双方用户层资料");
  migrated.evaluatorPrompt = migrated.evaluatorPrompt.slice(0, 200_000);
  if (!migrated.memoryPrompts || typeof migrated.memoryPrompts !== "object") migrated.memoryPrompts = clone(DEFAULT_CONFIG.memoryPrompts);
  if (typeof migrated.jsonRepairPrompt !== "string" || !migrated.jsonRepairPrompt) migrated.jsonRepairPrompt = DEFAULT_CONFIG.jsonRepairPrompt;
  migrated.jsonRepairPrompt = migrated.jsonRepairPrompt.slice(0, 200_000);
  if (!migrated.dailyReport || typeof migrated.dailyReport !== "object") migrated.dailyReport = clone(DEFAULT_CONFIG.dailyReport);
  (["investor", "founder"] as AgentRole[]).forEach((role) => {
    if (typeof migrated.memoryPrompts[role] !== "string" || !migrated.memoryPrompts[role]) migrated.memoryPrompts[role] = DEFAULT_CONFIG.memoryPrompts[role];
    migrated.memoryPrompts[role] = migrated.memoryPrompts[role].slice(0, 200_000);
    migrated.dailyReport[role] = { ...clone(DEFAULT_CONFIG.dailyReport[role]), ...(migrated.dailyReport[role] || {}) };
    const daily = migrated.dailyReport[role];
    daily.taskPrompt = typeof daily.taskPrompt === "string" ? daily.taskPrompt.slice(0, 200_000) : DEFAULT_CONFIG.dailyReport[role].taskPrompt;
    daily.dynamicPrompt = typeof daily.dynamicPrompt === "string" ? daily.dynamicPrompt.slice(0, 200_000) : DEFAULT_CONFIG.dailyReport[role].dynamicPrompt;
    daily.taskVariants = normalizedVariants(daily.taskVariants, "日报任务层版本");
    daily.dynamicVariants = normalizedVariants(daily.dynamicVariants, "日报动态层版本");
    daily.maxTokens = Math.min(16_000, Math.max(64, Math.round(finiteNumber(daily.maxTokens, DEFAULT_CONFIG.dailyReport[role].maxTokens))));
  });
  return migrated;
}

function tokenEstimate(text: string) {
  const ascii = (text.match(/[\x00-\x7F]/g) || []).length;
  return Math.max(1, Math.ceil((text.length - ascii) / 1.7 + ascii / 4));
}

function money(value: number) {
  return value === 0 ? "$0.0000" : `$${value.toFixed(4)}`;
}

function formatDuration(ms: number) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
}

function extractJson(raw: string): unknown {
  const candidates = [raw.trim()];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) candidates.push(fenced);
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("未找到可解析的 JSON 对象");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function rawFromError(value: unknown): string {
  const record = asRecord(value);
  return typeof record.raw === "string" ? record.raw : "";
}

function errorName(value: unknown): string {
  return value instanceof Error ? value.name : "";
}

function formatModelRequest(messages: Array<{ role: string; content: string }>) {
  return messages
    .map((message, index) => `[${String(index + 1).padStart(2, "0")} · ${message.role.toUpperCase()}]\n${message.content}`)
    .join("\n\n");
}

function normalizeControl(value: unknown): TurnControl {
  const control = asRecord(value);
  const allowed = new Set([
    "max_rounds", "sufficient_information", "clear_match", "clear_mismatch", "explicit_rejection",
    "missing_critical_information", "safety_or_compliance", "manual_stop", "no_new_information",
  ]);
  return {
    suggest_end: Boolean(control.suggest_end),
    end_reason: typeof control.end_reason === "string" && allowed.has(control.end_reason) ? control.end_reason as TurnControl["end_reason"] : null,
    information_sufficient: Boolean(control.information_sufficient),
  };
}

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState("user");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "登录失败");
      onSuccess();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="login-mark">VC</div>
        <p className="eyebrow">VENTURE AGENT LAB</p>
        <h1>创投社区数字分身<br />对话调试器</h1>
        <p className="login-subtitle">用于验证提示词控制、双 Agent 初筛对话与结构化记忆链路。</p>
        <form onSubmit={submit}>
          <label>账号<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label>密码<input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus /></label>
          {error && <div className="login-error">{error}</div>}
          <button className="primary wide" disabled={busy || !username || !password}>{busy ? "验证中…" : "进入调试器"}</button>
        </form>
        <p className="security-note">会话使用服务端签名的 HttpOnly Cookie；连续失败将触发限流。</p>
      </section>
    </main>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <label className="toggle-row">
      <button type="button" className={`toggle ${checked ? "on" : ""}`} aria-pressed={checked} onClick={() => onChange(!checked)}><span /></button>
      <span>{label}</span>
    </label>
  );
}

function JsonPanel({
  title,
  value,
  onChange,
  error,
  disabled = false,
  displayKind = "generic",
}: {
  title: string;
  value: unknown | null;
  onChange: (value: unknown) => void;
  error?: { raw: string; error: string };
  disabled?: boolean;
  displayKind?: JsonDisplayKind;
}) {
  const [mode, setMode] = useState<"read" | "raw">("read");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [editError, setEditError] = useState("");
  const rendered = value === null ? "" : JSON.stringify(value, null, 2);

  function save() {
    try {
      onChange(JSON.parse(draft));
      setEditing(false);
      setEditError("");
    } catch (caught) {
      setEditError(caught instanceof Error ? caught.message : "JSON 格式错误");
    }
  }

  return (
    <section className="json-card">
      <div className="card-heading">
        <div><span className="status-dot" /> <strong>{title}</strong></div>
        <div className="mini-actions">
          <button onClick={() => setMode(mode === "read" ? "raw" : "read")}>{mode === "read" ? "原始 JSON" : "阅读视图"}</button>
          <button disabled={disabled} onClick={() => { setDraft(rendered || error?.raw || "{}"); setEditing(!editing); }}>{editing ? "取消" : "编辑"}</button>
          <button disabled={!value && !error?.raw} onClick={() => copyText(rendered || error?.raw || "")}>复制</button>
          <button disabled={!value && !error?.raw} onClick={() => downloadJson(`${title}.json`, value ?? { raw: error?.raw, error: error?.error })}>下载</button>
        </div>
      </div>
      {error && <div className="inline-error"><strong>解析失败：</strong>{error.error}<details><summary>查看原始输出</summary><pre>{error.raw}</pre></details></div>}
      {!value && !error ? <div className="empty-panel">对话结束后在此生成</div> : editing ? (
        <div><textarea className="json-editor" value={draft} disabled={disabled} onChange={(event) => setDraft(event.target.value)} />{editError && <p className="field-error">{editError}</p>}<button className="primary small" disabled={disabled} onClick={save}>保存 JSON</button></div>
      ) : value ? (
        mode === "read"
          ? <div className="json-read-view"><JsonReadableView value={value} kind={displayKind} /></div>
          : <pre className="json-view">{rendered}</pre>
      ) : null}
    </section>
  );
}

function PromptLayerEditor({ role, layerKey, agent, onChange }: {
  role: AgentRole;
  layerKey: LayerKey;
  agent: AgentProfile;
  onChange: (agent: AgentProfile) => void;
}) {
  const [open, setOpen] = useState(layerKey === "platform" || layerKey === "user");
  const layer = agent.prompts[layerKey];
  const isProfileLayer = layerKey === "user";
  const profileContent = formatProfile(role, agent.fields) || "（尚未填写可传入 Agent 的资料）";
  const visibleContent = isProfileLayer ? profileContent : layer.content;
  const estimate = tokenEstimate(visibleContent);
  function saveVariant() {
    const name = window.prompt(`保存${LAYER_LABELS[layerKey]}版本名称`, `${LAYER_LABELS[layerKey]}方案 ${layer.variants.length + 1}`)?.trim();
    if (!name) return;
    const variant = { id: id("prompt"), name, content: layer.content, createdAt: new Date().toISOString() };
    onChange({ ...agent, prompts: { ...agent.prompts, [layerKey]: { ...layer, variants: [variant, ...layer.variants] } } });
  }
  return (
    <section className={`prompt-layer ${layer.enabled || isProfileLayer ? "" : "disabled"} ${isProfileLayer ? "profile-prompt-layer" : ""}`}>
      <div className="layer-head">
        <button className="layer-title" onClick={() => setOpen(!open)}><span>{open ? "⌄" : "›"}</span>{LAYER_LABELS[layerKey]}{isProfileLayer && <em>Agent 当前资料</em>}</button>
        <div className="layer-meta"><span>{visibleContent.length} 字符 · ≈{estimate} tokens</span>{isProfileLayer ? <b className="readonly-badge">自动生成 · 只读</b> : <button className={`tiny-toggle ${layer.enabled ? "on" : ""}`} onClick={() => onChange({ ...agent, prompts: { ...agent.prompts, [layerKey]: { ...layer, enabled: !layer.enabled } } })} aria-label={`${LAYER_LABELS[layerKey]}开关`}><span /></button>}</div>
      </div>
      {open && isProfileLayer && <div className="layer-body profile-layer-body">
        <div className="readonly-note">用户层由最近一次保存的资料自动生成，以下就是实际传给 Agent 的全部用户层内容。如需修改，请编辑上方资料字段并点击“保存资料并更新 Agent Card”。</div>
        <pre className="profile-layer-preview">{profileContent}</pre>
      </div>}
      {open && !isProfileLayer && <div className="layer-body">
        <div className="variant-row">
          <select defaultValue="" aria-label={`${LAYER_LABELS[layerKey]}已保存版本`} onChange={(event) => {
            const variant = layer.variants.find((item) => item.id === event.target.value);
            if (variant) onChange({ ...agent, prompts: { ...agent.prompts, [layerKey]: { ...layer, content: variant.content } } });
            event.target.value = "";
          }}><option value="">载入已保存版本（{layer.variants.length}）</option>{layer.variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.name}</option>)}</select>
          <button onClick={saveVariant}>保存当前为新版本</button>
          <button disabled={!layer.variants.length} onClick={() => {
            const name = window.prompt("输入要删除的版本名称", layer.variants[0]?.name)?.trim();
            if (!name) return;
            onChange({ ...agent, prompts: { ...agent.prompts, [layerKey]: { ...layer, variants: layer.variants.filter((item) => item.name !== name) } } });
          }}>删除版本</button>
        </div>
        <textarea value={layer.content} placeholder={layerKey === "dynamic" ? "当前为空；可手动注入实时状态或外部事件" : "输入提示词"} onChange={(event) => onChange({ ...agent, prompts: { ...agent.prompts, [layerKey]: { ...layer, content: event.target.value } } })} />
        {layerKey === "tools" && <div className={`tool-contract ${layer.enabled ? "connected" : ""}`}><span>{layer.enabled ? "● 已连接真实工具" : "○ 工具已停用"}</span><code>search_private_files(query, top_k)</code><em>服务端强制限定为当前 Agent 文件库</em></div>}
        <button className="text-button" onClick={() => onChange({ ...agent, prompts: { ...agent.prompts, [layerKey]: { ...layer, content: defaultLayer(role, layerKey) } } })}>↺ 恢复默认</button>
      </div>}
    </section>
  );
}

function QuestionnaireField({ definition, value, onChange }: { definition: FieldDefinition; value: string; onChange: (value: string) => void }) {
  const selected = new Set(value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean));
  const choices = [...(definition.options || []), ...[...selected].filter((item) => !definition.options?.includes(item))];
  const label = <span className="field-label">{definition.label}{definition.required ? <b>必填</b> : <em>选填</em>}</span>;
  if (definition.input === "date") return <label>{label}<input type="date" value={value} onChange={(event) => onChange(event.target.value)} />{definition.help && <small>{definition.help}</small>}</label>;
  if (definition.input === "textarea") return <label className="full">{label}<textarea value={value} placeholder={definition.placeholder} onChange={(event) => onChange(event.target.value)} />{definition.help && <small>{definition.help}</small>}</label>;
  if (definition.input === "select") return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)}><option value="">请选择</option>{value && !definition.options?.includes(value) && <option value={value}>{value}（已有自定义值）</option>}{definition.options?.map((option) => <option key={option}>{option}</option>)}</select>{definition.help && <small>{definition.help}</small>}</label>;
  if (definition.input === "multiselect") return <fieldset className="full choice-field"><legend>{label}</legend><div className="choice-chips">{choices.map((option) => <label key={option} className={selected.has(option) ? "selected" : ""}><input type="checkbox" checked={selected.has(option)} onChange={() => {
    const next = new Set(selected);
    if (next.has(option)) next.delete(option);
    else if (definition.exclusiveOptions?.includes(option)) {
      next.clear();
      next.add(option);
    } else {
      definition.exclusiveOptions?.forEach((exclusive) => next.delete(exclusive));
      if (definition.maxSelections && next.size >= definition.maxSelections) return;
      next.add(option);
    }
    onChange([...next].join("、"));
  }} /><span>{option}{!definition.options?.includes(option) ? " · 自定义" : ""}</span></label>)}</div>{definition.help && <small>{definition.help}</small>}</fieldset>;
  return <label>{label}<input value={value} placeholder={definition.placeholder} onChange={(event) => onChange(event.target.value)} />{definition.help && <small>{definition.help}</small>}</label>;
}

function DailyVariantControl({ label, content, variants, onContent, onVariants }: { label: string; content: string; variants: PromptVariant[]; onContent: (value: string) => void; onVariants: (value: PromptVariant[]) => void }) {
  return <div className="variant-row daily-variants"><select defaultValue="" onChange={(event) => {
    const variant = variants.find((item) => item.id === event.target.value);
    if (variant) onContent(variant.content);
    event.target.value = "";
  }}><option value="">载入{label}版本（{variants.length}）</option>{variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.name}</option>)}</select><button onClick={() => {
    const name = window.prompt(`保存${label}版本名称`, `${label}方案 ${variants.length + 1}`)?.trim();
    if (name) onVariants([{ id: id("daily-prompt"), name, content, createdAt: new Date().toISOString() }, ...variants]);
  }}>保存新版本</button><button disabled={!variants.length} onClick={() => {
    const name = window.prompt(`输入要删除的${label}版本名称`, variants[0]?.name)?.trim();
    if (name) onVariants(variants.filter((item) => item.name !== name));
  }}>删除版本</button></div>;
}

function AgentCardView({ role, card }: { role: AgentRole; card: DemoAgentCard }) {
  const definitions = new Map(FIELD_DEFINITIONS[role].map((field) => [field.key, field.label]));
  return <section className="agent-card agent-module">
    <div className="agent-card-head">
      <div><span className="visibility-badge public">公开给对方 Agent</span><strong>A2A 1.0 参考 Agent Card</strong><em>基于最近一次保存的资料自动生成 · 只读</em></div>
      <code>{card.version}</code>
    </div>
    <p>{card.description}</p>
    <div className="agent-card-grid">
      {Object.entries(card.publicIdentity.claims).map(([key, value]) => <div className="agent-card-claim" key={key}><span>{definitions.get(key) || key}</span><strong>{value}</strong></div>)}
    </div>
    <div className="agent-card-skills"><span>公开技能</span>{card.skills.flatMap((skill) => skill.tags).slice(0, 10).map((tag) => <b key={tag}>{tag}</b>)}</div>
    <details className="agent-card-json"><summary>查看 Card JSON</summary><pre>{JSON.stringify(card, null, 2)}</pre></details>
  </section>;
}

function DirectChatPanel({ role, state, busy, disabled, error, onNew, onSelect, onDelete, onSend, onPreviewCall, onPreviewPrompt }: {
  role: AgentRole;
  state: DirectChatRoleState;
  busy: boolean;
  disabled: boolean;
  error: string;
  onNew: () => void;
  onSelect: (threadId: string) => void;
  onDelete: () => void;
  onSend: (content: string) => Promise<boolean>;
  onPreviewCall: (call: DebugCall) => void;
  onPreviewPrompt: (thread: DirectChatThread) => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const active = state.threads.find((thread) => thread.id === state.activeThreadId) || null;
  useEffect(() => { messageEndRef.current?.scrollIntoView({ block: "nearest" }); }, [active?.messages.length]);

  async function submit() {
    const content = draft.trim();
    if (!content || !active || sending || disabled) return;
    setSending(true);
    const accepted = await onSend(content);
    if (accepted) setDraft("");
    setSending(false);
  }

  return <section className="agent-module test-chat-module">
    <div className="direct-chat-head">
      <div><span className="visibility-badge private">用户测试 · 不限轮次</span><strong>与自己的{ROLE_LABEL[role]} Agent 对话</strong><em>沿用创建会话时冻结的本 Agent 五层提示词与本方私有文件工具</em></div>
      <button disabled={disabled || busy} onClick={onNew}>＋ 创建新对话</button>
    </div>
    {state.threads.length > 0 && <div className="direct-chat-history">
      <label>当前对话<select value={active?.id || ""} disabled={disabled || busy} onChange={(event) => onSelect(event.target.value)}>{state.threads.map((thread, index) => <option key={thread.id} value={thread.id}>对话 {state.threads.length - index} · {new Date(thread.createdAt).toLocaleString("zh-CN")}</option>)}</select></label>
      {active && <button onClick={() => onPreviewPrompt(active)}>查看冻结提示词</button>}
      {active && <button className="danger-text" disabled={disabled || busy || sending} onClick={onDelete}>删除当前对话</button>}
      <span>{active?.messages.length || 0} 条消息 · 无平台轮次上限</span>
    </div>}
    <div className="direct-chat-messages">
      {!active ? <div className="direct-chat-empty"><strong>还没有用户测试对话</strong><p>点击“创建新对话”后即可向 Agent 提问；Agent 可按需检索已上传的正常 PDF。</p></div> : active.messages.length ? active.messages.map((message) => {
        const call = message.callId ? active.debugCalls.find((item) => item.id === message.callId) : null;
        const hits = message.toolCalls.reduce((sum, tool) => sum + tool.results.length, 0);
        return <article className={`direct-chat-message ${message.role}`} key={message.id}>
          <header><strong>{message.role === "user" ? "你" : active.agentSnapshot.fields.agentName || ROLE_LABEL[role]}</strong><time>{new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}</time></header>
          <p>{message.content}</p>
          {message.role === "assistant" && <footer>
            {message.toolCalls.length > 0 && <span className="direct-chat-tool">已调用工具 {message.toolCalls.length} 次 · 命中 {hits} 个片段</span>}
            <span>{message.inputTokens + message.outputTokens} tokens</span>
            {call && <button onClick={() => onPreviewCall(call)}>完整请求 / 工具轨迹</button>}
          </footer>}
        </article>;
      }) : <div className="direct-chat-empty"><strong>新对话已创建</strong><p>输入问题开始测试；不会因 control 建议结束而自动关闭。</p></div>}
      {busy && <article className="direct-chat-message assistant thinking"><p><span className="spinner" /> Agent 正在回复，可能会调用私有文件工具…</p></article>}
      <div ref={messageEndRef} />
    </div>
    {error && <div className="direct-chat-error">{error}</div>}
    <div className="direct-chat-composer">
      <textarea value={draft} disabled={!active || disabled || sending} placeholder={active ? "输入问题；Enter 发送，Shift+Enter 换行" : "请先创建新对话"} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
      }} />
      <div className="direct-chat-actions"><span>不限制对话轮次；仍受模型上下文与单次 Token 上限约束</span><button className="primary" disabled={!active || !draft.trim() || disabled || sending} onClick={() => void submit()}>{sending ? "发送中…" : "发送"}</button></div>
    </div>
  </section>;
}

function agentFileUrl(role: AgentRole, fileId: string, mode: "preview" | "download"): string {
  const query = new URLSearchParams({ role });
  if (mode === "download") query.set("download", "1");
  else query.set("preview", "1");
  return `/api/files/${fileId}?${query.toString()}`;
}

function isPdfPreviewFile(file: AgentFileRecord): boolean {
  return file.originalName.toLowerCase().endsWith(".pdf");
}

function isTextPreviewFile(file: AgentFileRecord): boolean {
  const extension = file.originalName.split(".").pop()?.toLowerCase() || "";
  return ["txt", "md", "markdown", "csv"].includes(extension);
}

function canOpenFilePreview(file: AgentFileRecord): boolean {
  return file.status === "ready" && (isPdfPreviewFile(file) || isTextPreviewFile(file));
}

function FilePreviewModal({
  role,
  file,
  textContent,
  textLoading,
  textError,
  onClose,
}: {
  role: AgentRole;
  file: AgentFileRecord;
  textContent: string | null;
  textLoading: boolean;
  textError: string;
  onClose: () => void;
}) {
  const previewUrl = agentFileUrl(role, file.id, "preview");
  const downloadUrl = agentFileUrl(role, file.id, "download");
  const pdf = isPdfPreviewFile(file);
  const text = isTextPreviewFile(file);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="modal file-preview-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <p>FILE PREVIEW</p>
            <h2>{file.originalName}</h2>
          </div>
          <button type="button" onClick={onClose}>×</button>
        </div>
        <div className="file-preview-body">
          {pdf ? <iframe title={file.originalName} src={previewUrl} /> : null}
          {text && textLoading ? <div className="file-preview-placeholder">正在加载文件内容…</div> : null}
          {text && textError ? <div className="inline-error">{textError}</div> : null}
          {text && !textLoading && !textError ? <pre className="file-preview-text">{textContent || "（空文件）"}</pre> : null}
          {!pdf && !text ? (
            <div className="file-preview-placeholder">
              此格式暂不支持在线预览，请下载后在本地查看。
            </div>
          ) : null}
        </div>
        <div className="modal-foot">
          <span>{formatBytes(file.size)} · {file.status === "ready" ? `${file.chunkCount} 个检索片段` : file.status}</span>
          <a className="primary-link" href={downloadUrl} download={file.originalName}>下载到本地</a>
        </div>
      </section>
    </div>
  );
}

function AgentFilePanel({ role, files, disabled, onFilesChange }: {
  role: AgentRole;
  files: AgentFileRecord[];
  disabled: boolean;
  onFilesChange: (files: AgentFileRecord[], uploadedIds?: string[]) => void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [previewFile, setPreviewFile] = useState<AgentFileRecord | null>(null);
  const [previewTextContent, setPreviewTextContent] = useState<string | null>(null);
  const [previewTextLoading, setPreviewTextLoading] = useState(false);
  const [previewTextError, setPreviewTextError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function closePreview() {
    setPreviewFile(null);
    setPreviewTextContent(null);
    setPreviewTextLoading(false);
    setPreviewTextError("");
  }

  async function openFile(file: AgentFileRecord) {
    if (isPdfPreviewFile(file)) {
      setPreviewFile(file);
      setPreviewTextContent(null);
      setPreviewTextLoading(false);
      setPreviewTextError("");
      return;
    }
    if (isTextPreviewFile(file)) {
      setPreviewFile(file);
      setPreviewTextContent(null);
      setPreviewTextLoading(true);
      setPreviewTextError("");
      try {
        const response = await fetch(agentFileUrl(role, file.id, "preview"), { cache: "no-store" });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(typeof data.error === "string" ? data.error : "读取文件失败");
        }
        setPreviewTextContent(await response.text());
      } catch (caught) {
        setPreviewTextError(caught instanceof Error ? caught.message : "读取文件失败");
      } finally {
        setPreviewTextLoading(false);
      }
      return;
    }
    window.open(agentFileUrl(role, file.id, "download"), "_blank", "noopener,noreferrer");
  }

  async function refresh(uploadedIds: string[] = []) {
    const response = await fetch(`/api/files?role=${role}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取文件列表失败");
    onFilesChange(data.files || [], uploadedIds);
  }

  async function upload(selected: FileList | null) {
    if (!selected?.length) return;
    setWorking(true); setError("");
    try {
      const form = new FormData();
      form.append("role", role);
      Array.from(selected).slice(0, 5).forEach((file) => form.append("files", file));
      const response = await fetch("/api/files", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "上传失败");
      const uploadedIds = Array.isArray(data.files) ? data.files.flatMap((file: unknown) => isPlainObject(file) && typeof file.id === "string" ? [file.id] : []) : [];
      await refresh(uploadedIds);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "上传失败");
    } finally {
      setWorking(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove(file: AgentFileRecord) {
    if (!window.confirm(`删除“${file.originalName}”？此操作会同时删除服务器中的原文件和索引。`)) return;
    setWorking(true); setError("");
    try {
      const response = await fetch(`/api/files/${file.id}?role=${role}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "删除失败");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删除失败");
    } finally { setWorking(false); }
  }

  return <details open className="agent-files-section">
    <summary><div><span>当前资料的私有文件</span><em>仅这套{ROLE_LABEL[role]}资料可检索</em></div><b>{files.filter((file) => file.status === "ready").length} 个</b></summary>
    <div className="agent-files-body">
      <label className={`file-drop ${disabled || working ? "disabled" : ""}`}>
        <input ref={inputRef} type="file" multiple accept=".pdf,.docx,.txt,.md,.markdown,.csv" disabled={disabled || working} onChange={(event) => upload(event.target.files)} />
        <span>{working ? "正在解析并建立索引…" : "＋ 上传 PDF、DOCX、TXT、Markdown 或 CSV"}</span>
        <small>单文件 ≤ 10MB · 每次最多 5 个 · 每个角色合计最多 20 个 · 自动关联当前资料</small>
      </label>
      {disabled && <div className="files-run-note">模拟运行期间文件快照已冻结，结束后可继续上传或删除。</div>}
      {error && <div className="inline-error">{error}</div>}
      <div className="file-list">
        {files.length ? files.map((file) => <article key={file.id}>
          <div className={`file-icon ${file.status}`}>{file.originalName.split(".").pop()?.slice(0, 4).toUpperCase()}</div>
          <div className="file-info">
            <button type="button" className="file-link" title={file.originalName} onClick={() => void openFile(file)}>{file.originalName}</button>
            <span>{formatBytes(file.size)} · {file.status === "ready" ? `${file.chunkCount} 个检索片段` : file.status === "processing" ? "处理中" : "解析失败"} · <span className={`file-status ${file.status}`}>{file.status === "ready" ? "可检索" : file.status === "processing" ? "处理中" : "失败"}</span></span>
            {file.error && <em>{file.error}</em>}
          </div>
          <div className="file-actions">
            {canOpenFilePreview(file) ? <button type="button" disabled={working} onClick={() => void openFile(file)}>预览</button> : null}
            <a href={agentFileUrl(role, file.id, "download")} download={file.originalName}>下载</a>
            <button type="button" disabled={disabled || working} onClick={() => remove(file)}>删除</button>
          </div>
        </article>) : <div className="empty-file-list">尚未上传文件。没有文件时，工具会返回空结果。</div>}
      </div>
      {previewFile ? (
        <FilePreviewModal
          role={role}
          file={previewFile}
          textContent={previewTextContent}
          textLoading={previewTextLoading}
          textError={previewTextError}
          onClose={closePreview}
        />
      ) : null}
    </div>
  </details>;
}

function AgentPanel({ role, config, onConfig, memory, onMemory, promptPreview, files, filesDisabled, onFilesChange,
  chatState, chatBusy, chatDisabled, chatError, onNewChat, onSelectChat, onDeleteChat, onSendChat, onPreviewChatCall, onPreviewChatPrompt,
  profileOptions, onSelectProfile, onCreateProfile, onProfileDirty, onSaveProfile,
}: {
  role: AgentRole;
  config: AppConfig;
  onConfig: (config: AppConfig) => void;
  memory: unknown | null;
  onMemory: (value: unknown) => void;
  promptPreview: () => void;
  files: AgentFileRecord[];
  filesDisabled: boolean;
  onFilesChange: (files: AgentFileRecord[], uploadedIds?: string[]) => void;
  chatState: DirectChatRoleState;
  chatBusy: boolean;
  chatDisabled: boolean;
  chatError: string;
  onNewChat: () => void;
  onSelectChat: (threadId: string) => void;
  onDeleteChat: () => void;
  onSendChat: (content: string) => Promise<boolean>;
  onPreviewChatCall: (call: DebugCall) => void;
  onPreviewChatPrompt: (thread: DirectChatThread) => void;
  profileOptions: UserProfileRecord[];
  onSelectProfile: (profileId: string) => void;
  onCreateProfile: () => void;
  onProfileDirty: (role: AgentRole, dirty: boolean) => void;
  onSaveProfile: (fields: Record<string, string>) => void;
}) {
  const agent = config[role];
  const [draftFields, setDraftFields] = useState<Record<string, string>>(() => clone(agent.fields));
  const color = role === "investor" ? "indigo" : "teal";
  const definitions = FIELD_DEFINITIONS[role];
  const publicFields = definitions.filter((field) => isAgentCardField(role, field.key));
  const privateRequiredFields = definitions.filter((field) => field.required && !isAgentCardField(role, field.key));
  const privateOptionalFields = definitions.filter((field) => !field.required && !isAgentCardField(role, field.key));
  const requiredFields = definitions.filter((field) => field.required);
  const requiredDone = requiredFields.filter((field) => draftFields[field.key]?.trim()).length;
  const optionalDone = definitions.filter((field) => !field.required && draftFields[field.key]?.trim()).length;
  const completion = requiredFields.length ? Math.round(requiredDone / requiredFields.length * 100) : 100;
  const dirty = JSON.stringify(draftFields) !== JSON.stringify(agent.fields);
  const card = buildAgentCard(agent);
  const selectedProfile = profileOptions.find((profile) => profile.id === agent.id) || profileOptions[0];
  useEffect(() => { onProfileDirty(role, dirty); }, [dirty, onProfileDirty, role]);
  function update(agentValue: AgentProfile) { onConfig({ ...config, [role]: agentValue }); }
  const renderField = (field: FieldDefinition) => <QuestionnaireField key={field.key} definition={field} value={draftFields[field.key] || ""} onChange={(value) => setDraftFields((current) => ({ ...current, [field.key]: value }))} />;
  function saveProfile() {
    onSaveProfile(clone(draftFields));
  }
  return (
    <section className={`agent-panel ${color}`}>
      <div className="agent-panel-head">
        <div className={`agent-avatar ${color}`}>{role === "investor" ? "投" : "创"}</div>
        <div><p>{ROLE_LABEL[role]} AGENT</p><h2>{agent.fields.agentName}</h2></div>
        <button className="outline" onClick={promptPreview}>查看最终组合提示词</button>
      </div>
      <div className="profile-library-bar">
        <div><strong>当前用户资料</strong><span>A-A / B-B 为匹配组合，交叉选择用于测试不匹配</span></div>
        <label><select aria-label={`${ROLE_LABEL[role]}用户资料方案`} value={selectedProfile?.id || ""} disabled={dirty || filesDisabled} onChange={(event) => onSelectProfile(event.target.value)}>{profileOptions.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}{profile.kind === "preset" ? " · 预设" : " · 自定义"}</option>)}</select></label>
        <button disabled={dirty || filesDisabled || profileOptions.length >= 20} onClick={onCreateProfile}>＋ 新增资料</button>
        <span className={`profile-kind ${selectedProfile?.kind || "custom"}`}>{selectedProfile?.kind === "preset" ? "内置预设" : "自定义资料"}</span>
      </div>
      <AgentCardView role={role} card={card} />
      <section className="agent-module profile-module">
        <div className="module-heading"><div><strong>用户资料</strong><span>编辑草稿不会立即影响 Agent；保存后同步用户层与 Agent Card</span></div><span className="visibility-badge private">本 Agent 完整上下文</span></div>
        <div className="profile-progress">
          <div><strong>基础资料完整度</strong><span>{completion}% · 选填已补充 {optionalDone} 项</span></div>
          <div className="progress-track" role="progressbar" aria-label={`${ROLE_LABEL[role]}基础资料完整度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={completion}><i style={{ width: `${completion}%` }} /></div>
          <p>{requiredDone === requiredFields.length ? "核心初筛资料已齐全；保存后才会进入正式提示词和公开卡片。" : `还有 ${requiredFields.length - requiredDone} 项核心资料未填，建议补齐后保存。`}</p>
        </div>
        <details open className="profile-section public-profile-section">
          <summary><span>公开身份资料 · Agent Card 白名单</span><span>{publicFields.filter((field) => draftFields[field.key]?.trim()).length} / {publicFields.length} 已填写</span></summary>
          <div className="questionnaire-note">这些字段保存后会进入公开 Agent Card，并只在双 Agent 模拟开始时作为对方的未核验身份声明发送；用户测试对话不会携带另一方 Card。初筛必问、内部判断、风险和详细数据不会进入卡片。</div>
          <div className="field-grid">{publicFields.map(renderField)}</div>
        </details>
        <details open className="profile-section private-profile-section">
          <summary><span>内部初筛资料 · 必填但不公开</span><span>{privateRequiredFields.filter((field) => draftFields[field.key]?.trim()).length} / {privateRequiredFields.length} 已填写</span></summary>
          <div className="questionnaire-note">只进入本 Agent 的只读用户层，不会放入对方 Agent Card。没有填写的内容，Agent 必须回答不知道；不愿直接公开的临时限制也可放动态层。</div>
          <div className="field-grid">{privateRequiredFields.map(renderField)}</div>
        </details>
        <details className="profile-section advanced-profile">
          <summary><span>高级内部画像 · 选填</span><span>{privateOptionalFields.filter((field) => draftFields[field.key]?.trim()).length} / {privateOptionalFields.length} 已填写</span></summary>
          <div className="questionnaire-note">详细、敏感或需证据核验的内容建议通过私有文件提供；当前仍是单一共享账号 Demo，不适合生产级机密。</div>
          <div className="field-grid">{privateOptionalFields.map(renderField)}</div>
        </details>
        <div className={`profile-savebar ${dirty ? "dirty" : ""}`}><div><strong>{dirty ? "有尚未保存的资料修改" : "资料已保存并与 Agent Card 同步"}</strong><span>{dirty ? "模拟和新测试对话仍会使用上一次保存的资料" : `当前公开 ${Object.keys(card.publicIdentity.claims).length} 个字段`}</span></div><div><button disabled={!dirty || filesDisabled} onClick={() => setDraftFields(clone(agent.fields))}>撤销修改</button><button className="primary" disabled={!dirty || filesDisabled} onClick={saveProfile}>保存资料并更新 Agent Card</button></div></div>
      </section>
      <section className="agent-module files-module"><div className="module-heading"><div><strong>私有文件与工具</strong><span>详细材料由本 Agent 按问题检索，不公开给对方</span></div><span className="visibility-badge private">仅本 Agent</span></div><AgentFilePanel role={role} files={files} disabled={filesDisabled} onFilesChange={onFilesChange} /></section>
      <section className="agent-module prompts-module"><div className="module-heading"><div><strong>五层提示词</strong><span>动态层适合放不愿直接公开的限制与临时状态；不会进入 Agent Card</span></div><span>按固定顺序组合</span></div>{(Object.keys(LAYER_LABELS) as LayerKey[]).map((key) => <PromptLayerEditor key={key} role={role} layerKey={key} agent={agent} onChange={update} />)}</section>
      <section className="agent-module memory-module"><div className="module-heading"><div><strong>当前私有记忆</strong><span>不会发送给对方 Agent</span></div><span className="visibility-badge private">仅本 Agent</span></div><div className="private-memory"><JsonPanel title={`${ROLE_LABEL[role]}私有记忆`} value={memory} onChange={onMemory} disabled={filesDisabled} displayKind={role === "investor" ? "investor_memory" : "founder_memory"} /></div></section>
      <DirectChatPanel key={`${role}-${agent.id}-${chatState.activeThreadId || "none"}`} role={role} state={chatState} busy={chatBusy} disabled={chatDisabled} error={chatError} onNew={onNewChat} onSelect={onSelectChat} onDelete={onDeleteChat} onSend={onSendChat} onPreviewCall={onPreviewChatCall} onPreviewPrompt={onPreviewChatPrompt} />
    </section>
  );
}

function Conversation({ messages, runningRole, status }: { messages: TurnMessage[]; runningRole: AgentRole | null; status: RunStatus }) {
  if (!messages.length && status === "idle") return (
    <div className="conversation-empty"><div className="empty-orbit"><span>投</span><i>⇄</i><span>创</span></div><h3>准备开始一轮投融资初筛</h3><p>系统将固定双方提示词与资料快照，并按设置逐条生成对话。</p></div>
  );
  return (
    <div className="message-list">
      {messages.map((message) => <article key={message.id} className={`message ${message.role}`}>
        <div className="message-avatar">{message.role === "investor" ? "投" : "创"}</div>
        <div className="message-main">
          <div className="message-head"><strong>{message.agentName}</strong><span>{ROLE_LABEL[message.role]} · 第 {message.round} 轮</span><time>{new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}</time></div>
          <p>{message.content}</p>
          <div className="message-stats"><span>{formatDuration(message.durationMs)}</span><span>输入 {message.inputTokens}{message.usageEstimated ? "≈" : ""}</span><span>输出 {message.outputTokens}{message.usageEstimated ? "≈" : ""}</span><span>{money(message.estimatedCost)}</span>{message.control.suggest_end && <em>建议结束 · {message.control.end_reason || "未说明"}</em>}</div>
        </div>
      </article>)}
      {runningRole && status === "running" && <article className={`message thinking ${runningRole}`}><div className="message-avatar">{runningRole === "investor" ? "投" : "创"}</div><div className="thinking-line"><span /><span /><span /> {ROLE_LABEL[runningRole]}正在生成回复</div></article>}
      {status === "postprocessing" && <div className="processing-banner"><span className="spinner" /> 对话已结束，正在生成结构化结果与双方记忆…</div>}
    </div>
  );
}

function DebugList({ calls }: { calls: DebugCall[] }) {
  if (!calls.length) return <div className="conversation-empty compact"><h3>暂无模型调用</h3><p>开始模拟后，每次调用的提示词、消息历史、Token 与原始返回都会记录在这里。</p></div>;
  return <div className="debug-list">{[...calls].reverse().map((call) => <details key={call.id} className={`debug-call ${call.success ? "ok" : "bad"}`}>
    <summary><span className="call-status">{call.success ? "✓" : "!"}</span><strong>{call.type}</strong><span>{call.actor}{call.round ? ` · 第 ${call.round} 轮` : ""}</span><span>{formatDuration(call.durationMs)}</span><span>{call.totalTokens} tokens{call.usageEstimated ? "（估算）" : ""}</span><time>{new Date(call.startedAt).toLocaleTimeString("zh-CN", { hour12: false })}</time></summary>
    <div className="debug-detail">
      {call.error && <div className="inline-error">{call.error}</div>}
      <h4>完整请求消息（按实际提交顺序）</h4><pre>{formatModelRequest(call.messages)}</pre>
      <h4>系统提示词</h4><pre>{call.systemPrompt}</pre>
      <h4>层级开关</h4><pre>{JSON.stringify(call.layerStates, null, 2)}</pre>
      <h4>Agent 信息快照</h4><pre>{JSON.stringify(call.profileSnapshot, null, 2)}</pre>
      <h4>消息数组（原始结构）</h4><pre>{JSON.stringify(call.messages, null, 2)}</pre>
      {call.toolCalls?.length ? <><h4>真实工具调用与检索结果</h4><pre>{JSON.stringify(call.toolCalls, null, 2)}</pre></> : null}
      <h4>原始模型返回</h4><pre>{call.rawResponse || "（无）"}</pre>
      <h4>解析结果</h4><pre>{JSON.stringify(call.parsedResult, null, 2)}</pre>
    </div>
  </details>)}</div>;
}

export default function DemoApp() {
  const [auth, setAuth] = useState<"checking" | "signed-out" | "signed-in">("checking");
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [workspaceLoadError, setWorkspaceLoadError] = useState("");
  const [workspaceReloadKey, setWorkspaceReloadKey] = useState(0);
  const [workspaceSaveRetry, setWorkspaceSaveRetry] = useState(0);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("loading");
  const [saveConflict, setSaveConflict] = useState<string[]>([]);
  const [config, setConfig] = useState<AppConfig>(() => deepCloneConfig(DEFAULT_CONFIG));
  const [profiles, setProfiles] = useState<UserProfileLibrary>(() => deepCloneUserProfiles());
  const [versions, setVersions] = useState<SavedVersion[]>([]);
  const [records, setRecords] = useState<SimulationRecord[]>([]);
  const [directChats, setDirectChats] = useState<DirectChatState>(() => emptyDirectChats());
  const [agentFiles, setAgentFiles] = useState<Record<AgentRole, AgentFileRecord[]>>({ investor: [], founder: [] });
  const [agentFilesReady, setAgentFilesReady] = useState(false);
  const [activeVersion, setActiveVersion] = useState<string | null>(null);
  const [activeRecordId, setActiveRecordId] = useState<string | null>(null);
  const [tab, setTab] = useState<TopTab>("conversation");
  const [status, setStatus] = useState<RunStatus>("idle");
  const [messages, setMessages] = useState<TurnMessage[]>([]);
  const [debugCalls, setDebugCalls] = useState<DebugCall[]>([]);
  const [publicResult, setPublicResult] = useState<unknown | null>(null);
  const [investorMemory, setInvestorMemory] = useState<unknown | null>(null);
  const [founderMemory, setFounderMemory] = useState<unknown | null>(null);
  const [dailyReports, setDailyReports] = useState<Record<AgentRole, unknown | null>>({ investor: null, founder: null });
  const [dailyBusy, setDailyBusy] = useState<AgentRole | null>(null);
  const [directChatBusy, setDirectChatBusy] = useState<AgentRole | null>(null);
  const [directChatErrors, setDirectChatErrors] = useState<Record<AgentRole, string>>({ investor: "", founder: "" });
  const [profileDirty, setProfileDirty] = useState<Record<AgentRole, boolean>>({ investor: false, founder: false });
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [rawErrors, setRawErrors] = useState<Record<string, { raw: string; error: string }>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [runningRole, setRunningRole] = useState<AgentRole | null>(null);
  const [promptModal, setPromptModal] = useState<{ title: string; content: string } | null>(null);
  const [versionOpen, setVersionOpen] = useState(false);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [debugDrawer, setDebugDrawer] = useState(false);
  const [apiState, setApiState] = useState<{ configured: boolean; missing: string[]; model: string | null } | null>(null);
  const [toast, setToast] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const pauseRef = useRef(false);
  const stopRef = useRef(false);
  const lastRunRef = useRef<AppConfig | null>(null);
  const lastRunFilesRef = useRef<Record<AgentRole, AgentFileRecord[]> | null>(null);
  const lastRunMemoriesRef = useRef<Record<AgentRole, unknown | null> | null>(null);
  const serverSnapshotRef = useRef<Record<string, string>>({});
  const serverRevisionRef = useRef<string | null>(null);
  const latestWorkspacePatchRef = useRef<WorkspaceStatePatch>({});
  const latestWorkspaceSerializedRef = useRef<Record<string, string>>({});
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const logoutInProgressRef = useRef(false);
  const profileDirtyRef = useRef<Record<AgentRole, boolean>>({ investor: false, founder: false });
  const orphanFileMigrationDoneRef = useRef(false);

  const currentWorkspacePatch = useCallback((): WorkspaceStatePatch => {
    return {
      config,
      profiles,
      versions,
      records: records.slice(0, 20),
      directChats,
      memories: { investor: investorMemory, founder: founderMemory },
      dailyReports,
      activeVersion,
      activeRecordId,
    };
  }, [activeRecordId, activeVersion, config, dailyReports, directChats, founderMemory, investorMemory, profiles, records, versions]);

  const renderedWorkspacePatch = currentWorkspacePatch();
  latestWorkspacePatchRef.current = renderedWorkspacePatch;
  latestWorkspaceSerializedRef.current = Object.fromEntries(Object.entries(renderedWorkspacePatch).map(([key, value]) => [key, JSON.stringify(value)]));
  const workspacePersisted = saveStatus === "saved"
    && WORKSPACE_PATCH_KEYS.every((key) => latestWorkspaceSerializedRef.current[key] === serverSnapshotRef.current[key]);

  const persistWorkspacePatch = useCallback(async function savePatch(patch: WorkspaceStatePatch, serialized: Record<string, string>, allowRebase = true): Promise<boolean> {
    const sentKeys = Object.keys(patch) as Array<keyof WorkspaceStatePatch>;
    const baseSnapshot = { ...serverSnapshotRef.current };
    const response = await fetch("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...patch, expectedUpdatedAt: serverRevisionRef.current }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      setAuth("signed-out");
      throw new Error("会话已失效，请重新登录");
    }
    if (response.status === 409 && data.state) {
      const current = data.state as WorkspaceState;
      const currentSnapshot = serializedWorkspaceState(current);
      const conflictingKeys = sentKeys.filter((key) => currentSnapshot[key] !== baseSnapshot[key]);
      if (!conflictingKeys.length && allowRebase) {
        const latestLocalSnapshot = latestWorkspaceSerializedRef.current;
        const safeServerKeys = WORKSPACE_PATCH_KEYS.filter((key) => !sentKeys.includes(key) && latestLocalSnapshot[key] === baseSnapshot[key]);
        const safe = new Set<string>(safeServerKeys);
        serverSnapshotRef.current = currentSnapshot;
        serverRevisionRef.current = current.updatedAt;
        function adoptServerSlice<K extends keyof WorkspaceStatePatch>(key: K, value: WorkspaceStatePatch[K]) {
          latestWorkspacePatchRef.current = { ...latestWorkspacePatchRef.current, [key]: value };
          latestWorkspaceSerializedRef.current = { ...latestWorkspaceSerializedRef.current, [key]: JSON.stringify(value) };
        }
        // Only adopt a server slice if it has not changed locally since this
        // request began. New local edits stay dirty and are saved afterwards.
        if (safe.has("config")) { const value = migrateConfig(current.config); adoptServerSlice("config", value); setConfig(value); }
        if (safe.has("profiles")) { const value = clone(current.profiles); adoptServerSlice("profiles", value); setProfiles(value); }
        if (safe.has("versions")) { adoptServerSlice("versions", current.versions); setVersions(current.versions); }
        if (safe.has("records")) { const value = current.records.slice(0, 20); adoptServerSlice("records", value); setRecords(value); }
        if (safe.has("directChats")) { const value = clone(current.directChats); adoptServerSlice("directChats", value); setDirectChats(value); }
        if (safe.has("memories")) {
          const value = clone(current.memories);
          adoptServerSlice("memories", value);
          setInvestorMemory(clone(value.investor ?? null));
          setFounderMemory(clone(value.founder ?? null));
        }
        if (safe.has("dailyReports")) { const value = clone(current.dailyReports); adoptServerSlice("dailyReports", value); setDailyReports(value); }
        if (safe.has("activeVersion")) { adoptServerSlice("activeVersion", current.activeVersion); setActiveVersion(current.activeVersion); }
        if (safe.has("activeRecordId")) { adoptServerSlice("activeRecordId", current.activeRecordId); setActiveRecordId(current.activeRecordId); }
        return savePatch(patch, serialized, false);
      }
      const conflicts = conflictingKeys.length ? conflictingKeys.map(String) : sentKeys.map(String);
      const message = `服务器工作区冲突：另一个页面也修改了 ${conflicts.join("、")}。`;
      setSaveConflict(conflicts);
      setSaveStatus("error");
      setErrors((currentErrors) => currentErrors.includes(message) ? currentErrors : [...currentErrors, message]);
      return false;
    }
    if (!response.ok) throw new Error(data.error || "保存服务端工作区失败");
    sentKeys.forEach((key) => { serverSnapshotRef.current[key] = serialized[key]; });
    serverRevisionRef.current = typeof data.updatedAt === "string" ? data.updatedAt : serverRevisionRef.current;
    setSaveConflict([]);
    const stillDirty = WORKSPACE_PATCH_KEYS.some((key) => latestWorkspaceSerializedRef.current[key] !== serverSnapshotRef.current[key]);
    setSaveStatus(stillDirty ? "saving" : "saved");
    setErrors((currentErrors) => currentErrors.filter((message) => !message.startsWith("服务端自动保存失败：") && !message.startsWith("服务器工作区冲突：")));
    return true;
  }, []);

  useEffect(() => {
    fetch("/api/auth/session").then((response) => {
      if (!response.ok) throw new Error();
      return response.json();
    }).then(() => setAuth("signed-in")).catch(() => setAuth("signed-out"));
  }, []);

  useEffect(() => {
    if (auth !== "signed-in") return;
    let cancelled = false;

    async function loadWorkspace() {
      const response = await fetch("/api/state", { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) {
        setAuth("signed-out");
        return;
      }
      if (!response.ok) throw new Error(data.error || "读取服务端工作区失败");
      let state = data.state as WorkspaceState;
      const migrationWarnings: string[] = [];

      if (!state.updatedAt) {
        const legacyConfigRaw = localStorage.getItem(LEGACY_CONFIG_KEY);
        const legacyVersionsRaw = localStorage.getItem(LEGACY_VERSION_KEY);
        const legacyRecordsRaw = localStorage.getItem(LEGACY_RECORD_KEY);
        let legacyConfig: AppConfig | null = null;
        let legacyVersions: SavedVersion[] | null = null;
        let legacyRecords: SimulationRecord[] | null = null;
        if (legacyConfigRaw) {
          try {
            const parsed = JSON.parse(legacyConfigRaw);
            if (!isConfigCandidate(parsed)) throw new Error("旧配置结构无效");
            legacyConfig = migrateConfig(parsed);
          }
          catch { migrationWarnings.push("旧浏览器配置已损坏，已忽略并使用服务器默认配置。"); localStorage.removeItem(LEGACY_CONFIG_KEY); }
        }
        if (legacyVersionsRaw) {
          try {
            const normalized = normalizeLegacyVersions(JSON.parse(legacyVersionsRaw));
            legacyVersions = normalized.items;
            if (normalized.discarded) migrationWarnings.push(`旧浏览器配置版本中有 ${normalized.discarded} 条损坏记录，已丢弃。`);
          } catch { migrationWarnings.push("旧浏览器配置版本已损坏，已忽略。"); localStorage.removeItem(LEGACY_VERSION_KEY); }
        }
        if (legacyRecordsRaw) {
          try {
            const normalized = normalizeLegacyRecords(JSON.parse(legacyRecordsRaw));
            legacyRecords = normalized.items;
            if (normalized.discarded) migrationWarnings.push(`旧浏览器模拟记录中有 ${normalized.discarded} 条损坏记录，已丢弃。`);
          } catch { migrationWarnings.push("旧浏览器模拟记录已损坏，已忽略。"); localStorage.removeItem(LEGACY_RECORD_KEY); }
        }
        if (legacyConfig || legacyVersions || legacyRecords) {
          const migratedRecords = legacyRecords || [];
          const latest = migratedRecords[0];
          const migrationConfig = legacyConfig || migrateConfig(state.config);
          const migrationMemories = {
            investor: latest?.results.investorMemory ?? null,
            founder: latest?.results.founderMemory ?? null,
          };
          const migrationReports = latest?.results.dailyReports ?? { investor: null, founder: null };
          const patch: WorkspaceStatePatch = {
            config: migrationConfig,
            profiles: migrateLegacyProfiles(state.profiles || deepCloneUserProfiles(), migrationConfig, migrationMemories, migrationReports),
            versions: legacyVersions || [],
            records: migratedRecords,
            memories: migrationMemories,
            dailyReports: migrationReports,
            activeVersion: latest?.configVersion ?? null,
            activeRecordId: latest?.conversationId ?? null,
          };
          const migrationResponse = await fetch("/api/state", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...patch, expectedUpdatedAt: state.updatedAt }),
          });
          const migrationData = await migrationResponse.json().catch(() => ({}));
          if (!migrationResponse.ok) throw new Error(migrationData.error || "迁移浏览器旧数据失败");
          state = { ...state, ...patch, updatedAt: migrationData.updatedAt || new Date().toISOString() } as WorkspaceState;
        }
      }

      if (cancelled) return;
      let normalizedConfig = migrateConfig(state.config);
      const normalizedVersions = normalizeLegacyVersions(state.versions);
      const normalizedRecords = normalizeLegacyRecords(state.records);
      const serverVersions = normalizedVersions.items;
      const serverRecords = normalizedRecords.items;
      if (normalizedVersions.discarded) migrationWarnings.push(`服务器工作区中有 ${normalizedVersions.discarded} 条无效配置版本，已自动清理。`);
      if (normalizedRecords.discarded) migrationWarnings.push(`服务器工作区中有 ${normalizedRecords.discarded} 条无效模拟记录，已自动清理。`);
      const activeRecord = serverRecords.find((record) => record.conversationId === state.activeRecordId) || null;
      const validActiveVersion = serverVersions.some((version) => version.id === state.activeVersion) ? state.activeVersion : null;
      const memories = state.memories || { investor: null, founder: null };
      const reports = state.dailyReports || { investor: null, founder: null };
      const normalizedProfiles = syncProfilesWithConfig(state.profiles || deepCloneUserProfiles(), normalizedConfig, memories, reports);
      normalizedConfig = clone(normalizedConfig);
      (["investor", "founder"] as AgentRole[]).forEach((role) => {
        const profile = activeUserProfile(normalizedProfiles, normalizedConfig, role);
        normalizedConfig[role] = {
          ...normalizedConfig[role],
          id: profile.id,
          fields: clone(profile.fields),
          prompts: { ...normalizedConfig[role].prompts, dynamic: clone(profile.dynamicLayer) },
        };
      });
      const activeInvestorProfile = activeUserProfile(normalizedProfiles, normalizedConfig, "investor");
      const activeFounderProfile = activeUserProfile(normalizedProfiles, normalizedConfig, "founder");
      const loadedDirectChats = clone(state.directChats || emptyDirectChats());
      (["investor", "founder"] as AgentRole[]).forEach((role) => {
        const currentId = loadedDirectChats[role].activeThreadId;
        const currentThread = loadedDirectChats[role].threads.find((thread) => thread.id === currentId);
        if (currentThread?.agentSnapshot.id !== normalizedConfig[role].id) {
          loadedDirectChats[role].activeThreadId = loadedDirectChats[role].threads.find((thread) => thread.agentSnapshot.id === normalizedConfig[role].id)?.id || null;
        }
      });

      setConfig(normalizedConfig);
      setProfiles(normalizedProfiles);
      setVersions(serverVersions);
      setRecords(serverRecords);
      setDirectChats(loadedDirectChats);
      setActiveVersion(validActiveVersion);
      setActiveRecordId(activeRecord?.conversationId || null);
      setInvestorMemory(clone(activeInvestorProfile.memory));
      setFounderMemory(clone(activeFounderProfile.memory));
      setDailyReports({ investor: clone(activeInvestorProfile.dailyReport), founder: clone(activeFounderProfile.dailyReport) });
      setMessages(activeRecord ? clone(activeRecord.messages) : []);
      setDebugCalls(activeRecord ? clone(activeRecord.debugCalls) : []);
      setPublicResult(activeRecord ? clone(activeRecord.results.public ?? null) : null);
      setRawErrors(activeRecord ? clone(activeRecord.results.rawErrors) : {});
      setErrors([...(activeRecord ? [...clone(activeRecord.errors), ...(activeRecord.completedAt ? [] : ["上次运行在完成前中断，已恢复当时保存的消息和调试记录。"])] : []), ...migrationWarnings]);
      setStatus(activeRecord ? (activeRecord.completedAt ? "completed" : "error") : "idle");
      if (activeRecord) {
        lastRunRef.current = clone(activeRecord.configSnapshot);
        lastRunFilesRef.current = clone(activeRecord.fileSnapshots);
        lastRunMemoriesRef.current = clone(activeRecord.memorySnapshots);
      }
      serverSnapshotRef.current = {
        config: JSON.stringify(state.config),
        profiles: JSON.stringify(state.profiles || deepCloneUserProfiles()),
        versions: JSON.stringify(state.versions),
        records: JSON.stringify(state.records),
        directChats: JSON.stringify(state.directChats || emptyDirectChats()),
        memories: JSON.stringify(memories),
        dailyReports: JSON.stringify(reports),
        activeVersion: JSON.stringify(state.activeVersion),
        activeRecordId: JSON.stringify(state.activeRecordId),
      };
      serverRevisionRef.current = state.updatedAt;
      setSaveConflict([]);
      LEGACY_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
      setWorkspaceReady(true);
      setSaveStatus("saved");
    }

    loadWorkspace().catch((caught) => {
      if (cancelled) return;
      setWorkspaceLoadError(caught instanceof Error ? caught.message : String(caught));
      setSaveStatus("error");
    });
    return () => { cancelled = true; };
  }, [auth, workspaceReloadKey]);

  useEffect(() => {
    if (!workspaceReady || auth !== "signed-in" || saveConflict.length || logoutInProgressRef.current) return;
    const fullPatch = currentWorkspacePatch();
    const fullPatchRecord = fullPatch as Record<keyof WorkspaceStatePatch, WorkspaceStatePatch[keyof WorkspaceStatePatch]>;
    const serialized = Object.fromEntries(Object.entries(fullPatch).map(([key, value]) => [key, JSON.stringify(value)]));
    const changedKeys = Object.keys(serialized).filter((key) => serverSnapshotRef.current[key] !== serialized[key]) as Array<keyof WorkspaceStatePatch>;
    if (!changedKeys.length) { setSaveStatus("saved"); return; }
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    setSaveStatus("saving");
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      saveQueueRef.current = saveQueueRef.current.then(async () => {
        const pendingKeys = changedKeys.filter((key) => serverSnapshotRef.current[key] !== serialized[key]);
        if (!pendingKeys.length) { setSaveStatus("saved"); return; }
        const patch = Object.fromEntries(pendingKeys.map((key) => [key, fullPatchRecord[key]])) as WorkspaceStatePatch;
        const patchSerialized = Object.fromEntries(pendingKeys.map((key) => [key, serialized[key]]));
        await persistWorkspacePatch(patch, patchSerialized);
      }).catch((caught) => {
        const message = `服务端自动保存失败：${caught instanceof Error ? caught.message : String(caught)}`;
        setSaveStatus("error");
        setErrors((current) => current.includes(message) ? current : [...current, message]);
      });
    }, 400);
    return () => {
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    };
  }, [auth, currentWorkspacePatch, logoutBusy, persistWorkspacePatch, saveConflict, workspaceReady, workspaceSaveRetry]);

  useEffect(() => {
    function protectUnsavedChanges(event: BeforeUnloadEvent) {
      const hasUnsavedChanges = WORKSPACE_PATCH_KEYS.some((key) => latestWorkspaceSerializedRef.current[key] !== serverSnapshotRef.current[key]);
      const hasProfileDraft = Object.values(profileDirtyRef.current).some(Boolean);
      if (!hasUnsavedChanges && !hasProfileDraft && !saveTimerRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", protectUnsavedChanges);
    return () => window.removeEventListener("beforeunload", protectUnsavedChanges);
  }, []);

  useEffect(() => {
    if (auth !== "signed-in") return;
    setAgentFilesReady(false);
    orphanFileMigrationDoneRef.current = false;
    fetch("/api/health").then((response) => response.json()).then(setApiState).catch(() => setApiState({ configured: false, missing: ["无法连接服务端"], model: null }));
    Promise.all((["investor", "founder"] as AgentRole[]).map(async (role) => {
      const response = await fetch(`/api/files?role=${role}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取文件列表失败");
      return [role, data.files || []] as const;
    })).then((entries) => {
      setAgentFiles(Object.fromEntries(entries) as Record<AgentRole, AgentFileRecord[]>);
      setAgentFilesReady(true);
    }).catch((caught) => {
      setAgentFilesReady(true);
      setErrors((current) => [...current, `文件库加载失败：${caught instanceof Error ? caught.message : String(caught)}`]);
    });
  }, [auth]);
  useEffect(() => {
    if (!workspaceReady || !agentFilesReady || orphanFileMigrationDoneRef.current) return;
    orphanFileMigrationDoneRef.current = true;
    const readyFileIds = new Set(
      (["investor", "founder"] as AgentRole[]).flatMap((role) => agentFiles[role].filter((file) => file.status === "ready").map((file) => file.id)),
    );
    if (!readyFileIds.size) return;
    setProfiles((current) => {
      const next = attachPresetDemoFileIds(current, readyFileIds, new Date().toISOString());
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
  }, [agentFiles, agentFilesReady, workspaceReady]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 1800);
    return () => clearTimeout(timer);
  }, [toast]);

  const totalStats = useMemo(() => messages.reduce((sum, message) => ({ input: sum.input + message.inputTokens, output: sum.output + message.outputTokens, cost: sum.cost + message.estimatedCost }), { input: 0, output: 0, cost: 0 }), [messages]);
  const allDebugCalls = useMemo(() => [
    ...debugCalls,
    ...directChats.investor.threads.flatMap((thread) => thread.debugCalls),
    ...directChats.founder.threads.flatMap((thread) => thread.debugCalls),
  ].sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt)), [debugCalls, directChats]);

  function persistConfig(next: AppConfig) { setConfig(next); }

  function updateProfileById(role: AgentRole, profileId: string, update: Partial<UserProfileRecord>) {
    setProfiles((current) => ({
      ...current,
      [role]: current[role].map((profile) => profile.id === profileId
        ? { ...profile, ...clone(update), id: profile.id, role: profile.role, updatedAt: new Date().toISOString() }
        : profile),
    }));
  }

  function updateActiveProfile(role: AgentRole, update: Partial<UserProfileRecord>) {
    updateProfileById(role, config[role].id, update);
  }

  function clearActiveRunViewForProfileChange() {
    setMessages([]);
    setDebugCalls([]);
    setPublicResult(null);
    setRawErrors({});
    setErrors([]);
    setStatus("idle");
    setActiveRecordId(null);
    lastRunRef.current = null;
    lastRunFilesRef.current = null;
    lastRunMemoriesRef.current = null;
  }

  function persistAgentConfig(role: AgentRole, next: AppConfig) {
    setConfig(next);
    const agent = next[role];
    updateActiveProfile(role, { fields: clone(agent.fields), dynamicLayer: clone(agent.prompts.dynamic) });
  }

  function saveProfileFields(role: AgentRole, fields: Record<string, string>) {
    const nextAgent = { ...config[role], fields: clone(fields) };
    setConfig({ ...config, [role]: nextAgent });
    updateActiveProfile(role, { fields: clone(fields), dynamicLayer: clone(nextAgent.prompts.dynamic) });
    setRoleProfileDirty(role, false);
    setToast(`${ROLE_LABEL[role]}资料已保存，用户层与 Agent Card 已同步`);
  }

  function selectUserProfile(role: AgentRole, profileId: string) {
    if (profileDirtyRef.current[role]) { setToast(`请先保存或撤销${ROLE_LABEL[role]}资料草稿再切换`); return; }
    if (dailyBusy || directChatBusy || ["running", "paused", "stopping", "postprocessing"].includes(status)) return;
    const profile = profiles[role].find((item) => item.id === profileId);
    if (!profile) return;
    clearActiveRunViewForProfileChange();
    const nextAgent: AgentProfile = {
      ...config[role],
      id: profile.id,
      fields: clone(profile.fields),
      prompts: { ...config[role].prompts, dynamic: clone(profile.dynamicLayer) },
    };
    setConfig({ ...config, [role]: nextAgent });
    if (role === "investor") setInvestorMemory(clone(profile.memory));
    else setFounderMemory(clone(profile.memory));
    setDailyReports((current) => ({ ...current, [role]: clone(profile.dailyReport) }));
    setDirectChats((current) => {
      const latest = current[role].threads.find((thread) => thread.agentSnapshot.id === profile.id);
      return { ...current, [role]: { ...current[role], activeThreadId: latest?.id || null } };
    });
    setDirectChatErrors((current) => ({ ...current, [role]: "" }));
    setActiveVersion(null);
    setToast(`已切换到${ROLE_LABEL[role]}资料“${profile.name}”`);
  }

  function createUserProfile(role: AgentRole) {
    if (profileDirtyRef.current[role]) { setToast(`请先保存或撤销${ROLE_LABEL[role]}资料草稿再新增`); return; }
    if (profiles[role].length >= 20) { setToast(`每个角色最多保留 20 套资料`); return; }
    const customCount = profiles[role].filter((profile) => profile.kind === "custom").length;
    const name = window.prompt(`新增${ROLE_LABEL[role]}资料名称`, `我的${ROLE_LABEL[role]}资料 ${customCount + 1}`)?.trim();
    if (!name) return;
    if (name.length > 80) { setToast("资料名称不能超过 80 个字符"); return; }
    if (profiles[role].some((profile) => profile.name.toLocaleLowerCase() === name.toLocaleLowerCase())) { setToast("已有同名资料，请换一个名称"); return; }
    const profileId = `${role}-custom-${crypto.randomUUID()}`;
    const fields = Object.fromEntries(FIELD_DEFINITIONS[role].map((field) => [field.key, field.key === "agentName" ? name : ""]));
    const agent: AgentProfile = {
      ...config[role],
      id: profileId,
      fields,
      prompts: { ...config[role].prompts, dynamic: { enabled: false, content: "", variants: [] } },
    };
    const profile = userProfileFromAgent(agent, name, "custom", null, null, []);
    clearActiveRunViewForProfileChange();
    setProfiles((current) => ({ ...current, [role]: [profile, ...current[role]] }));
    setConfig({ ...config, [role]: agent });
    if (role === "investor") setInvestorMemory(null);
    else setFounderMemory(null);
    setDailyReports((current) => ({ ...current, [role]: null }));
    setDirectChats((current) => ({ ...current, [role]: { ...current[role], activeThreadId: null } }));
    setActiveVersion(null);
    setToast(`已创建空白${ROLE_LABEL[role]}资料；动态层、文件、记忆、日报和对话均为空`);
  }

  function handleAgentFilesChange(role: AgentRole, files: AgentFileRecord[], uploadedIds: string[] = []) {
    setAgentFiles((current) => ({ ...current, [role]: clone(files) }));
    const available = new Set(files.map((file) => file.id));
    const activeId = config[role].id;
    setProfiles((current) => ({
      ...current,
      [role]: current[role].map((profile) => {
        const retained = profile.fileIds.filter((fileId) => available.has(fileId));
        const fileIds = profile.id === activeId ? [...new Set([...retained, ...uploadedIds])].slice(0, 20) : retained;
        return JSON.stringify(fileIds) === JSON.stringify(profile.fileIds)
          ? profile
          : { ...profile, fileIds, updatedAt: new Date().toISOString() };
      }),
    }));
  }

  function filesForCurrentProfile(role: AgentRole): AgentFileRecord[] {
    const fileIds = new Set(activeUserProfile(profiles, config, role).fileIds);
    return agentFiles[role].filter((file) => fileIds.has(file.id));
  }

  function currentProfileFileSnapshots(): Record<AgentRole, AgentFileRecord[]> {
    return { investor: clone(filesForCurrentProfile("investor")), founder: clone(filesForCurrentProfile("founder")) };
  }

  function activateExternalConfig(source: AppConfig, sourceLabel: string): boolean {
    if (dailyBusy || directChatBusy || ["running", "paused", "stopping", "postprocessing"].includes(status)) {
      setToast(`请先结束当前模型任务，再${sourceLabel}`);
      return false;
    }
    const nextConfig = migrateConfig(source);
    const nextProfiles = clone(profiles);
    const selected: Record<AgentRole, UserProfileRecord | null> = { investor: null, founder: null };
    for (const role of ["investor", "founder"] as AgentRole[]) {
      const agent = nextConfig[role];
      const exact = nextProfiles[role].find((profile) => profile.id === agent.id
        && JSON.stringify(profile.fields) === JSON.stringify(agent.fields)
        && JSON.stringify(profile.dynamicLayer) === JSON.stringify(agent.prompts.dynamic));
      if (exact) { selected[role] = exact; continue; }
      if (nextProfiles[role].length >= 20) {
        setToast(`${ROLE_LABEL[role]}资料已达 20 套，无法${sourceLabel}`);
        return false;
      }
      agent.id = `${role}-custom-${crypto.randomUUID()}`;
      const profile = userProfileFromAgent(agent, `${sourceLabel} · ${agent.fields.agentName || ROLE_LABEL[role]}`, "custom");
      nextProfiles[role] = [profile, ...nextProfiles[role]];
      selected[role] = profile;
    }
    clearActiveRunViewForProfileChange();
    setProfiles(nextProfiles);
    setConfig(nextConfig);
    setInvestorMemory(clone(selected.investor?.memory ?? null));
    setFounderMemory(clone(selected.founder?.memory ?? null));
    setDailyReports({ investor: clone(selected.investor?.dailyReport ?? null), founder: clone(selected.founder?.dailyReport ?? null) });
    setDirectChats((current) => ({
      investor: { ...current.investor, activeThreadId: current.investor.threads.find((thread) => thread.agentSnapshot.id === nextConfig.investor.id)?.id || null },
      founder: { ...current.founder, activeThreadId: current.founder.threads.find((thread) => thread.agentSnapshot.id === nextConfig.founder.id)?.id || null },
    }));
    return true;
  }

  const setRoleProfileDirty = useCallback((role: AgentRole, dirty: boolean) => {
    profileDirtyRef.current = { ...profileDirtyRef.current, [role]: dirty };
    setProfileDirty(profileDirtyRef.current);
  }, []);

  function updateStoredResult(kind: "public" | "investorMemory" | "founderMemory", value: unknown) {
    if (kind === "public") setPublicResult(value);
    if (kind === "investorMemory") { setInvestorMemory(value); updateActiveProfile("investor", { memory: clone(value) }); }
    if (kind === "founderMemory") { setFounderMemory(value); updateActiveProfile("founder", { memory: clone(value) }); }
    if (!activeRecordId) return;
    setRecords((current) => current.map((record) => record.conversationId === activeRecordId
      && (kind === "public" || record.configSnapshot[kind === "investorMemory" ? "investor" : "founder"].id === config[kind === "investorMemory" ? "investor" : "founder"].id)
      ? { ...record, results: { ...record.results, [kind]: clone(value) } }
      : record));
  }

  function updateStoredDailyReport(role: AgentRole, value: unknown) {
    setDailyReports((current) => ({ ...current, [role]: value }));
    updateActiveProfile(role, { dailyReport: clone(value) });
    if (!activeRecordId) return;
    setRecords((current) => current.map((record) => record.conversationId === activeRecordId
      && record.configSnapshot[role].id === config[role].id
      ? { ...record, results: { ...record.results, dailyReports: { ...record.results.dailyReports, [role]: clone(value) } } }
      : record));
  }

  function newRecord(snapshot: AppConfig, fileSnapshots: Record<AgentRole, AgentFileRecord[]>, memorySnapshots: Record<AgentRole, unknown | null>): SimulationRecord {
    return {
      conversationId: id("conv"), createdAt: new Date().toISOString(), completedAt: null,
      configVersion: activeVersion, configSnapshot: clone(snapshot),
      agentCardSnapshots: { investor: buildAgentCard(snapshot.investor), founder: buildAgentCard(snapshot.founder) },
      promptSnapshots: { investor: composePrompt(snapshot.investor, snapshot.settings), founder: composePrompt(snapshot.founder, snapshot.settings) },
      fileSnapshots: clone(fileSnapshots),
      memorySnapshots: clone(memorySnapshots),
      messages: [], results: { public: null, investorMemory: null, founderMemory: null, dailyReports: { investor: null, founder: null }, rawErrors: {} },
      debugCalls: [], stats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 }, endReason: null, errors: [],
    };
  }

  function saveRecordProgress(record: SimulationRecord) {
    const snapshot = clone(record);
    setRecords((current) => [snapshot, ...current.filter((item) => item.conversationId !== snapshot.conversationId)].slice(0, 20));
  }

  function mergeDebugRecordProgress(record: SimulationRecord) {
    setRecords((current) => {
      const existing = current.find((item) => item.conversationId === record.conversationId);
      const snapshot = existing ? { ...existing, debugCalls: clone(record.debugCalls) } : clone(record);
      return [snapshot, ...current.filter((item) => item.conversationId !== snapshot.conversationId)].slice(0, 20);
    });
  }

  async function waitIfPaused() {
    while (pauseRef.current && !stopRef.current) await new Promise((resolve) => setTimeout(resolve, 150));
  }

  function historyFor(agentRole: AgentRole, current: TurnMessage[]) {
    return current.map((message) => ({ role: message.role === agentRole ? "assistant" as const : "user" as const, content: `${ROLE_LABEL[message.role]}（第${message.round}轮）：${message.content}` }));
  }

  async function modelCall(params: {
    record: SimulationRecord; type: DebugCall["type"]; actor: DebugCall["actor"]; round: number | null;
    systemPrompt: string; layerStates?: Record<string, boolean>; profile?: Record<string, string> | null;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>; maxTokens: number; snapshot: AppConfig;
    agentRole?: AgentRole; fileIds?: string[]; toolsEnabled?: boolean; recordProgress?: "replace" | "merge-debug" | "none"; publishDebug?: boolean;
  }) {
    const started = nowMs();
    const startedAt = new Date().toISOString();
    const inputEstimate = params.messages.reduce((sum, message) => sum + tokenEstimate(message.content), 0);
    let raw = "";
    let parsed: unknown = null;
    let inputTokens = inputEstimate;
    let outputTokens = 0;
    let usageEstimated = true;
    let callError: string | null = null;
    let toolCalls: ToolExecutionTrace[] = [];
    abortRef.current = new AbortController();
    try {
      const response = await fetch("/api/model", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: params.messages,
          maxTokens: params.maxTokens,
          agentRole: params.agentRole,
          profileId: params.agentRole ? params.snapshot[params.agentRole].id : undefined,
          fileIds: params.fileIds,
          toolsEnabled: params.toolsEnabled,
        }), signal: abortRef.current.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      raw = data.content;
      toolCalls = Array.isArray(data.toolCalls) ? data.toolCalls : [];
      if (data.usage?.prompt_tokens != null && data.usage?.completion_tokens != null) {
        inputTokens = Number(data.usage.prompt_tokens);
        outputTokens = Number(data.usage.completion_tokens);
        usageEstimated = false;
      } else outputTokens = tokenEstimate(raw);
      try { parsed = extractJson(raw); } catch {}
      return { raw, parsed, inputTokens, outputTokens, usageEstimated };
    } catch (caught) {
      callError = caught instanceof Error ? caught.message : String(caught);
      if (caught instanceof DOMException && caught.name === "AbortError") callError = "请求已由用户停止";
      throw caught;
    } finally {
      const ended = nowMs();
      const cost = inputTokens / 1_000_000 * params.snapshot.settings.inputPricePerMillion + outputTokens / 1_000_000 * params.snapshot.settings.outputPricePerMillion;
      const debug: DebugCall = {
        id: id("call"), type: params.type, actor: params.actor, round: params.round,
        systemPrompt: params.systemPrompt, layerStates: params.layerStates || {}, profileSnapshot: params.profile ?? null,
        messages: clone(params.messages), rawResponse: raw, parsedResult: parsed,
        startedAt, endedAt: new Date(ended).toISOString(), durationMs: ended - started,
        inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, usageEstimated, estimatedCost: cost,
        success: !callError, error: callError, toolCalls,
      };
      params.record.debugCalls.push(debug);
      if (params.publishDebug !== false) setDebugCalls([...params.record.debugCalls]);
      if (params.recordProgress === "merge-debug") mergeDebugRecordProgress(params.record);
      else if (params.recordProgress !== "none") saveRecordProgress(params.record);
      abortRef.current = null;
    }
  }

  async function parseWithRepair(raw: string, context: string, record: SimulationRecord, snapshot: AppConfig, recordProgress: "replace" | "merge-debug" | "none" = "replace", publishDebug = true): Promise<unknown> {
    try { return extractJson(raw); } catch (firstError) {
      const systemPrompt = snapshot.jsonRepairPrompt;
      const repairMessages = [{ role: "system" as const, content: systemPrompt }, { role: "user" as const, content: `目标：${context}\n\n待修复内容：\n${raw}` }];
      const repaired = await modelCall({ record, type: "json_repair", actor: "system", round: null, systemPrompt, messages: repairMessages, maxTokens: snapshot.settings.maxTokens, snapshot, recordProgress, publishDebug });
      try { return extractJson(repaired.raw); } catch (secondError) {
        const message = `首次解析：${firstError instanceof Error ? firstError.message : String(firstError)}；修复后解析：${secondError instanceof Error ? secondError.message : String(secondError)}`;
        throw Object.assign(new Error(message), { raw: repaired.raw || raw });
      }
    }
  }

  async function postprocess(record: SimulationRecord, snapshot: AppConfig) {
    if (stopRef.current && record.messages.length === 0) return;
    setStatus("postprocessing");
    setRunningRole(null);
    const transcript = record.messages.map((message) => `[第${message.round}轮·${ROLE_LABEL[message.role]}] ${message.content}`).join("\n\n");
    const profileContext = `【投资人用户层资料】\n${formatProfile("investor", snapshot.investor.fields)}\n\n【创业者用户层资料】\n${formatProfile("founder", snapshot.founder.fields)}`;

    async function generateResult(kind: "public" | "investorMemory" | "founderMemory") {
      const isPublic = kind === "public";
      const role: AgentRole = kind === "founderMemory" ? "founder" : "investor";
      const systemPrompt = isPublic ? snapshot.evaluatorPrompt : composeMemoryPrompt(snapshot, role);
      const actor = isPublic ? "evaluator" as const : role;
      const type: DebugCall["type"] = isPublic ? "public_evaluation" : role === "investor" ? "investor_memory" : "founder_memory";
      const storedMemory = record.memorySnapshots[role];
      const expectedCounterpartyId = snapshot[otherRole(role)].id;
      const previousMemoryValue = storedMemory != null && asRecord(storedMemory).counterparty_id === expectedCounterpartyId
        ? storedMemory
        : null;
      const previousMemory = isPublic ? "" : `\n\n【更新前的${ROLE_LABEL[role]}私有记忆】\n${previousMemoryValue == null ? "（暂无；首次创建或本次对手资料已变化，不得合并其他主体的旧记忆）" : JSON.stringify(previousMemoryValue, null, 2)}`;
      const userContent = `${profileContext}${previousMemory}\n\n【完整对话】\n${transcript}\n\nconversation_id: ${record.conversationId}\ninvestor_agent_id: ${snapshot.investor.id}\nfounder_agent_id: ${snapshot.founder.id}\nconversation_end_reason: ${record.endReason || "unknown"}`;
      try {
        const response = await modelCall({ record, type, actor, round: null, systemPrompt,
          layerStates: isPublic ? {} : Object.fromEntries(Object.entries(snapshot[role].prompts).map(([key, layer]) => [key, key === "task" || key === "user" ? true : layer.enabled])),
          profile: isPublic ? null : snapshot[role].fields,
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }],
          maxTokens: Math.max(1200, snapshot.settings.maxTokens), snapshot,
          agentRole: isPublic ? undefined : role,
          fileIds: isPublic ? undefined : record.fileSnapshots[role].filter((file) => file.status === "ready").map((file) => file.id),
          toolsEnabled: !isPublic && snapshot[role].prompts.tools.enabled,
        });
        const result = await parseWithRepair(response.raw, type, record, snapshot);
        record.results[kind] = result;
        if (kind === "public") setPublicResult(result);
        if (kind === "investorMemory") {
          updateProfileById("investor", snapshot.investor.id, { memory: clone(result) });
          if (config.investor.id === snapshot.investor.id) setInvestorMemory(result);
        }
        if (kind === "founderMemory") {
          updateProfileById("founder", snapshot.founder.id, { memory: clone(result) });
          if (config.founder.id === snapshot.founder.id) setFounderMemory(result);
        }
        saveRecordProgress(record);
      } catch (caught: unknown) {
        const label = isPublic ? "公共结果" : role === "investor" ? "投资人记忆" : "创业者记忆";
        const error = `${label}生成失败：${caught instanceof Error ? caught.message : String(caught)}`;
        record.errors.push(error);
        record.results.rawErrors[kind] = { raw: rawFromError(caught), error };
        setErrors([...record.errors]);
        setRawErrors({ ...record.results.rawErrors });
        saveRecordProgress(record);
      }
    }

    if (snapshot.settings.generatePublicResult) await generateResult("public");
    if (snapshot.settings.generateMemories) {
      await generateResult("investorMemory");
      await generateResult("founderMemory");
    }
  }

  async function runSimulation(snapshot: AppConfig, filesSnapshot: Record<AgentRole, AgentFileRecord[]>, memorySnapshots: Record<AgentRole, unknown | null>) {
    const record = newRecord(snapshot, filesSnapshot, memorySnapshots);
    setActiveRecordId(record.conversationId);
    saveRecordProgress(record);
    lastRunRef.current = snapshot;
    lastRunFilesRef.current = clone(filesSnapshot);
    lastRunMemoriesRef.current = clone(memorySnapshots);
    stopRef.current = false;
    pauseRef.current = false;
    setMessages([]); setDebugCalls([]); setPublicResult(null); setRawErrors({}); setErrors([]); setTab("conversation");
    setStatus("running");

    const order: AgentRole[] = snapshot.settings.firstSpeaker === "investor" ? ["investor", "founder"] : ["founder", "investor"];
    const sufficient = new Set<AgentRole>();
    let pendingEndFrom: AgentRole | null = null;
    let pendingReason: string | null = null;
    let shouldEnd = false;

    try {
      outer: for (let round = 1; round <= snapshot.settings.maxRounds; round += 1) {
        for (const role of order) {
          await waitIfPaused();
          if (stopRef.current) break outer;
          setRunningRole(role);
          const agent = snapshot[role];
          const systemPrompt = record.promptSnapshots[role];
          const history = historyFor(role, record.messages);
          const apiMessages = [
            { role: "system" as const, content: systemPrompt },
            { role: "user" as const, content: formatPeerAgentCardMessage(record.agentCardSnapshots[otherRole(role)]) },
            ...history,
          ];
          if (!history.length) apiMessages.push({ role: "user", content: "请根据本次任务与资料开始对话，直接输出约定 JSON。" });
          else apiMessages.push({ role: "user", content: pendingEndFrom && pendingEndFrom !== role ? "对方建议结束。请给出最后一次有价值的回应，并在适当时确认结束。直接输出约定 JSON。" : "请回应对方最新发言，直接输出约定 JSON。" });
          const started = Date.now();
          try {
            const response = await modelCall({
              record, type: role === "investor" ? "investor_turn" : "founder_turn", actor: role, round, systemPrompt,
              layerStates: { ...Object.fromEntries(Object.entries(agent.prompts).map(([key, layer]) => [key, key === "user" ? true : layer.enabled])), identity: true }, profile: clone(agent.fields),
              messages: apiMessages, maxTokens: snapshot.settings.maxTokens, snapshot,
              agentRole: role,
              fileIds: filesSnapshot[role].filter((file) => file.status === "ready").map((file) => file.id),
              toolsEnabled: agent.prompts.tools.enabled,
            });
            const parsed = await parseWithRepair(response.raw, `${ROLE_LABEL[role]}第 ${round} 轮对话回复，必须包含 message 和 control`, record, snapshot);
            const parsedRecord = asRecord(parsed);
            if (typeof parsedRecord.message !== "string" || !parsedRecord.message.trim()) throw Object.assign(new Error("结构化输出缺少非空 message 字段"), { raw: response.raw });
            const control = normalizeControl(parsedRecord.control);
            const cost = response.inputTokens / 1_000_000 * snapshot.settings.inputPricePerMillion + response.outputTokens / 1_000_000 * snapshot.settings.outputPricePerMillion;
            const turn: TurnMessage = { id: id("turn"), role, agentName: agent.fields.agentName || ROLE_LABEL[role], round, content: parsedRecord.message.trim(), control,
              durationMs: Date.now() - started, inputTokens: response.inputTokens, outputTokens: response.outputTokens, usageEstimated: response.usageEstimated, estimatedCost: cost, createdAt: new Date().toISOString() };
            record.messages.push(turn);
            setMessages([...record.messages]);
            const latestDebug = record.debugCalls[record.debugCalls.length - 1];
            if (latestDebug) latestDebug.parsedResult = parsed;
            setDebugCalls([...record.debugCalls]);
            saveRecordProgress(record);

            if (control.information_sufficient) sufficient.add(role);
            if (snapshot.settings.allowEarlyEnd) {
              if (pendingEndFrom && pendingEndFrom !== role) {
                record.endReason = pendingReason || control.end_reason || "sufficient_information";
                shouldEnd = true;
              } else if (control.suggest_end || control.information_sufficient) {
                pendingEndFrom = role;
                pendingReason = control.end_reason || (control.information_sufficient ? "sufficient_information" : null);
              }
              if (sufficient.size === 2) { record.endReason = "sufficient_information"; shouldEnd = true; }
            }
          } catch (caught: unknown) {
            if (stopRef.current || errorName(caught) === "AbortError") break outer;
            const stage = `${ROLE_LABEL[role]}第 ${round} 轮生成失败`;
            record.errors.push(`${stage}：${caught instanceof Error ? caught.message : String(caught)}`);
            setErrors([...record.errors]);
            record.endReason = "missing_critical_information";
            shouldEnd = true;
          } finally {
            setRunningRole(null);
          }
          if (shouldEnd) break outer;
        }
      }
      if (stopRef.current) record.endReason = "manual_stop";
      else if (!record.endReason) record.endReason = "max_rounds";
      await postprocess(record, snapshot);
    } finally {
      record.completedAt = new Date().toISOString();
      record.stats = record.messages.reduce((sum, message) => ({ inputTokens: sum.inputTokens + message.inputTokens, outputTokens: sum.outputTokens + message.outputTokens, estimatedCost: sum.estimatedCost + message.estimatedCost }), { inputTokens: 0, outputTokens: 0, estimatedCost: 0 });
      setRecords((current) => [clone(record), ...current.filter((item) => item.conversationId !== record.conversationId)].slice(0, 20));
      setDebugCalls([...record.debugCalls]);
      setStatus(record.messages.length || Object.values(record.results).some(Boolean) ? "completed" : "error");
      setRunningRole(null);
      stopRef.current = false;
    }
  }

  async function generateDailyReport(role: AgentRole) {
    if (dailyBusy || directChatBusy || ["running", "paused", "stopping", "postprocessing"].includes(status)) return;
    if (!workspacePersisted) { setToast("请等待当前资料保存到服务器后再生成日报"); return; }
    setDailyBusy(role);
    setErrors([]);
    const memory = role === "investor" ? investorMemory : founderMemory;
    const profileFiles = filesForCurrentProfile(role);
    // A daily-report call is a new model run with its own current prompt and
    // file snapshot. Keep it in a separate record instead of mutating a
    // completed simulation whose provenance may no longer match.
    const scratch = newRecord(clone(config), currentProfileFileSnapshots(), { investor: clone(investorMemory), founder: clone(founderMemory) });
    const targetRecordId = id("daily");
    scratch.conversationId = targetRecordId;
    const systemPrompt = composeDailyPrompt(config, role, memory);
    let generated: unknown | undefined;
    let generationError: string | null = null;
    try {
      const response = await modelCall({
        record: scratch,
        type: role === "investor" ? "investor_daily_report" : "founder_daily_report",
        actor: role,
        round: null,
        systemPrompt,
        layerStates: { platform: config[role].prompts.platform.enabled, tools: config[role].prompts.tools.enabled, user: true, task: true, dynamic: true },
        profile: clone(config[role].fields),
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `请生成 ${new Date().toLocaleDateString("zh-CN")} 的日报，直接输出约定 JSON。` }],
        maxTokens: config.dailyReport[role].maxTokens,
        snapshot: config,
        agentRole: role,
        fileIds: profileFiles.filter((file) => file.status === "ready").map((file) => file.id),
        toolsEnabled: config[role].prompts.tools.enabled,
        recordProgress: "merge-debug",
      });
      const result = await parseWithRepair(response.raw, `${ROLE_LABEL[role]}日报`, scratch, config, "merge-debug");
      const latest = scratch.debugCalls[scratch.debugCalls.length - 1];
      if (latest) latest.parsedResult = result;
      generated = result;
      setDebugCalls(clone(scratch.debugCalls));
      setDailyReports((current) => ({ ...current, [role]: result }));
      updateActiveProfile(role, { dailyReport: clone(result) });
      setToast(`${ROLE_LABEL[role]}日报已生成`);
    } catch (caught) {
      generationError = `${ROLE_LABEL[role]}日报生成失败：${caught instanceof Error ? caught.message : String(caught)}`;
      setDebugCalls(clone(scratch.debugCalls));
      setErrors([generationError]);
    } finally {
      if (!scratch.completedAt) scratch.completedAt = new Date().toISOString();
      scratch.results.dailyReports = { ...clone(dailyReports), ...(generated === undefined ? {} : { [role]: clone(generated) }) };
      scratch.errors = generationError ? [generationError] : [];
      setRecords((current) => [clone(scratch), ...current.filter((record) => record.conversationId !== targetRecordId)].slice(0, 20));
      setActiveRecordId(targetRecordId);
      setStatus(generated === undefined ? "error" : "completed");
      setDailyBusy(null);
    }
  }

  function createDirectChat(role: AgentRole) {
    if (directChatBusy || dailyBusy || ["running", "paused", "stopping", "postprocessing"].includes(status)) return;
    if (!workspacePersisted) { setToast("请等待当前资料保存到服务器后再创建对话"); return; }
    if (profileDirtyRef.current[role]) {
      setToast(`请先保存${ROLE_LABEL[role]}资料，再创建与自己 Agent 的测试对话`);
      return;
    }
    const currentRoleState = directChats[role];
    if (currentRoleState.threads.length >= 20) {
      setToast("每个角色最多保留 20 个用户对话；请先删除旧对话");
      return;
    }
    const profile = activeUserProfile(profiles, config, role);
    const allowedFileIds = new Set(profile.fileIds);
    const now = new Date().toISOString();
    const thread: DirectChatThread = {
      id: id("direct"),
      agentRole: role,
      createdAt: now,
      updatedAt: now,
      agentSnapshot: clone(config[role]),
      settingsSnapshot: clone(config.settings),
      promptSnapshot: composeDirectChatPrompt(config[role], config.settings),
      jsonRepairPromptSnapshot: config.jsonRepairPrompt,
      fileSnapshots: clone(agentFiles[role].filter((file) => allowedFileIds.has(file.id))),
      messages: [],
      debugCalls: [],
      errors: [],
    };
    setDirectChats((current) => ({ ...current, [role]: { activeThreadId: thread.id, threads: [thread, ...current[role].threads] } }));
    setDirectChatErrors((current) => ({ ...current, [role]: "" }));
    setToast(`${ROLE_LABEL[role]}用户测试对话已创建`);
  }

  function selectDirectChat(role: AgentRole, threadId: string) {
    if (directChatBusy) return;
    setDirectChats((current) => current[role].threads.some((thread) => thread.id === threadId && thread.agentSnapshot.id === config[role].id)
      ? { ...current, [role]: { ...current[role], activeThreadId: threadId } }
      : current);
    setDirectChatErrors((current) => ({ ...current, [role]: "" }));
  }

  function deleteDirectChat(role: AgentRole) {
    if (directChatBusy || dailyBusy || ["running", "paused", "stopping", "postprocessing"].includes(status)) return;
    const roleState = directChats[role];
    const activeIndex = roleState.threads.findIndex((thread) => thread.id === roleState.activeThreadId && thread.agentSnapshot.id === config[role].id) >= 0
      ? roleState.threads.findIndex((thread) => thread.id === roleState.activeThreadId)
      : roleState.threads.findIndex((thread) => thread.agentSnapshot.id === config[role].id);
    if (activeIndex < 0) return;
    if (!window.confirm(`确定删除当前${ROLE_LABEL[role]}用户测试对话吗？对话消息与工具轨迹将一并删除。`)) return;
    const deletedId = roleState.threads[activeIndex].id;
    setDirectChats((current) => {
      const currentRoleState = current[role];
      const currentIndex = currentRoleState.threads.findIndex((thread) => thread.id === deletedId);
      if (currentIndex < 0) return current;
      const threads = currentRoleState.threads.filter((thread) => thread.id !== deletedId);
      const activeThreadId = threads.find((thread) => thread.agentSnapshot.id === config[role].id)?.id || null;
      return { ...current, [role]: { activeThreadId, threads } };
    });
    setDirectChatErrors((current) => ({ ...current, [role]: "" }));
    setToast(`${ROLE_LABEL[role]}当前用户测试对话已删除`);
  }

  async function sendDirectChat(role: AgentRole, content: string): Promise<boolean> {
    if (directChatBusy || dailyBusy || ["running", "paused", "stopping", "postprocessing"].includes(status)) return false;
    const roleState = directChats[role];
    const thread = roleState.threads.find((item) => item.id === roleState.activeThreadId && item.agentSnapshot.id === config[role].id)
      || roleState.threads.find((item) => item.agentSnapshot.id === config[role].id);
    if (!thread) { setDirectChatErrors((current) => ({ ...current, [role]: "请先创建新对话。" })); return false; }
    const threadId = thread.id;
    const userMessage: DirectChatMessage = {
      id: id("direct-user"), role: "user", content: content.trim(), createdAt: new Date().toISOString(), callId: null,
      inputTokens: 0, outputTokens: 0, usageEstimated: false, estimatedCost: 0, toolCalls: [],
    };
    const history = [...thread.messages, userMessage];
    const recentHistory = history.slice(-80);
    const omitted = history.length - recentHistory.length;
    const apiMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: thread.promptSnapshot },
      ...(omitted > 0 ? [{ role: "user" as const, content: `【上下文边界】当前请求仅携带最近 ${recentHistory.length} 条消息，更早的 ${omitted} 条没有进入本次模型上下文。不得猜测或声称记得未提供的早期内容。` }] : []),
      ...recentHistory.map((message) => ({ role: message.role, content: message.content })),
    ];
    setDirectChatBusy(role);
    setDirectChatErrors((current) => ({ ...current, [role]: "" }));
    setDirectChats((current) => ({ ...current, [role]: { ...current[role], threads: current[role].threads.map((item) => item.id === threadId
      ? { ...item, updatedAt: userMessage.createdAt, messages: [...item.messages, userMessage] }
      : item) } }));

    const callSnapshot = clone(config);
    callSnapshot[role] = clone(thread.agentSnapshot);
    callSnapshot.settings = clone(thread.settingsSnapshot);
    callSnapshot.jsonRepairPrompt = thread.jsonRepairPromptSnapshot;
    const scratchFiles: Record<AgentRole, AgentFileRecord[]> = { investor: [], founder: [] };
    scratchFiles[role] = clone(thread.fileSnapshots);
    const scratch = newRecord(callSnapshot, scratchFiles, { investor: null, founder: null });
    scratch.debugCalls = [];
    try {
      const response = await modelCall({
        record: scratch,
        type: role === "investor" ? "investor_direct_chat" : "founder_direct_chat",
        actor: role,
        round: null,
        systemPrompt: thread.promptSnapshot,
        layerStates: Object.fromEntries(Object.entries(thread.agentSnapshot.prompts).map(([key, layer]) => [key, key === "user" ? true : layer.enabled])),
        profile: clone(thread.agentSnapshot.fields),
        messages: apiMessages,
        maxTokens: thread.settingsSnapshot.maxTokens,
        snapshot: callSnapshot,
        agentRole: role,
        fileIds: thread.fileSnapshots.filter((file) => file.status === "ready").map((file) => file.id),
        toolsEnabled: thread.agentSnapshot.prompts.tools.enabled,
        recordProgress: "none",
        publishDebug: false,
      });
      const result = await parseWithRepair(response.raw, `${ROLE_LABEL[role]}用户测试对话回复，必须包含 message 和 control`, scratch, callSnapshot, "none", false);
      const resultRecord = asRecord(result);
      if (typeof resultRecord.message !== "string" || !resultRecord.message.trim()) throw Object.assign(new Error("结构化输出缺少非空 message 字段"), { raw: response.raw });
      const directCall = scratch.debugCalls.find((call) => call.type === `${role}_direct_chat`);
      if (directCall) directCall.parsedResult = result;
      const toolCalls = clone(directCall?.toolCalls || []);
      const assistantMessage: DirectChatMessage = {
        id: id("direct-agent"), role: "assistant", content: resultRecord.message.trim(), createdAt: new Date().toISOString(),
        callId: directCall?.id || null, inputTokens: response.inputTokens, outputTokens: response.outputTokens,
        usageEstimated: response.usageEstimated,
        estimatedCost: response.inputTokens / 1_000_000 * thread.settingsSnapshot.inputPricePerMillion + response.outputTokens / 1_000_000 * thread.settingsSnapshot.outputPricePerMillion,
        toolCalls,
      };
      setDirectChats((current) => ({ ...current, [role]: { ...current[role], threads: current[role].threads.map((item) => item.id === threadId
        ? { ...item, updatedAt: assistantMessage.createdAt, messages: [...item.messages, assistantMessage], debugCalls: [...item.debugCalls, ...clone(scratch.debugCalls)] }
        : item) } }));
      return true;
    } catch (caught) {
      const message = `${ROLE_LABEL[role]}用户对话失败：${caught instanceof Error ? caught.message : String(caught)}`;
      setDirectChatErrors((current) => ({ ...current, [role]: message }));
      setDirectChats((current) => ({ ...current, [role]: { ...current[role], threads: current[role].threads.map((item) => item.id === threadId
        ? { ...item, updatedAt: new Date().toISOString(), debugCalls: [...item.debugCalls, ...clone(scratch.debugCalls)], errors: [...item.errors, message] }
        : item) } }));
      return true;
    } finally {
      setDirectChatBusy(null);
    }
  }

  function start() {
    if (dailyBusy || directChatBusy || ["running", "paused", "postprocessing"].includes(status)) return;
    if (!workspacePersisted) { setToast("请等待当前资料保存到服务器后再开始模拟"); return; }
    if (Object.values(profileDirtyRef.current).some(Boolean)) { setToast("请先保存双方资料，再冻结 Agent Card 并开始模拟"); return; }
    runSimulation(clone(config), currentProfileFileSnapshots(), { investor: clone(investorMemory), founder: clone(founderMemory) });
  }

  function rerunLastSnapshot() {
    if (modelBusy) return;
    if (!workspacePersisted) { setToast("请等待当前工作区保存到服务器后再重新生成"); return; }
    if (Object.values(profileDirtyRef.current).some(Boolean)) { setToast("请先保存或撤销双方资料草稿，再重新生成"); return; }
    if (!lastRunRef.current || !lastRunFilesRef.current || !lastRunMemoriesRef.current) { setToast("没有可重新生成的完整快照"); return; }
    runSimulation(clone(lastRunRef.current), clone(lastRunFilesRef.current), clone(lastRunMemoriesRef.current));
  }

  function stop() {
    stopRef.current = true;
    pauseRef.current = false;
    setStatus("stopping");
    abortRef.current?.abort();
  }

  function reset() {
    if (["running", "paused", "postprocessing"].includes(status)) stop();
    setMessages([]); setDebugCalls([]); setPublicResult(null); setRawErrors({}); setErrors([]); setStatus("idle"); setActiveRecordId(null);
    setToast("已重置当前对话；长期记忆与日报已保留");
  }

  function saveVersion() {
    if (profileDraftsBlock("保存命名版本")) return;
    const name = window.prompt("为当前配置命名", `配置 ${versions.length + 1}`)?.trim();
    if (!name) return;
    const version: SavedVersion = { id: id("version"), name, createdAt: new Date().toISOString(), config: clone(config) };
    setVersions((current) => [version, ...current].slice(0, 100)); setActiveVersion(version.id); setToast("配置版本已保存");
  }

  function profileDraftsBlock(action: string): boolean {
    if (!Object.values(profileDirtyRef.current).some(Boolean)) return false;
    setToast(`请先保存或撤销双方资料草稿，再${action}`);
    return true;
  }

  function importConfig(file: File) {
    if (profileDraftsBlock("导入配置")) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!isConfigCandidate(parsed)) throw new Error("配置结构无效或资料字段不是文本");
        if (activateExternalConfig(parsed, "导入资料")) { setActiveVersion(null); setToast("配置已导入；资料库中没有的身份已保存为自定义资料"); }
      } catch (caught) { setToast(`导入失败：${caught instanceof Error ? caught.message : "格式错误"}`); }
    };
    reader.readAsText(file);
  }

  function loadVersion(version: SavedVersion) {
    if (profileDraftsBlock("加载命名版本")) return;
    if (!activateExternalConfig(version.config, `版本 ${version.name}`)) return;
    setActiveVersion(version.id);
    setVersionOpen(false);
    setToast("版本已加载");
  }

  function loadRecord(record: SimulationRecord) {
    setMessages(clone(record.messages)); setDebugCalls(clone(record.debugCalls)); setPublicResult(clone(record.results.public));
    setRawErrors(clone(record.results.rawErrors));
    lastRunRef.current = clone(record.configSnapshot);
    lastRunFilesRef.current = clone(record.fileSnapshots);
    lastRunMemoriesRef.current = clone(record.memorySnapshots);
    setActiveRecordId(record.conversationId); setErrors(clone(record.errors)); setStatus("completed"); setRecordsOpen(false); setTab("conversation");
  }

  function handleSaveIssue() {
    if (saveConflict.length) {
      if (profileDraftsBlock("重新加载服务器工作区")) return;
      if (!window.confirm("服务器工作区已被另一个页面更新。重新加载会放弃本页面尚未保存的冲突字段，是否继续？")) return;
      setWorkspaceReady(false);
      setWorkspaceLoadError("");
      setSaveConflict([]);
      setSaveStatus("loading");
      serverSnapshotRef.current = {};
      serverRevisionRef.current = null;
      setWorkspaceReloadKey((value) => value + 1);
      return;
    }
    setWorkspaceSaveRetry((value) => value + 1);
  }

  async function logout() {
    if (saveConflict.length) { setToast("请先处理服务器工作区冲突"); return; }
    if (dailyBusy || directChatBusy || ["running", "paused", "stopping", "postprocessing"].includes(status)) { setToast("请先结束当前模型任务再退出"); return; }
    if (Object.values(profileDirtyRef.current).some(Boolean)) { setToast("请先保存或撤销资料草稿再退出"); return; }
    setLogoutBusy(true);
    logoutInProgressRef.current = true;
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    try {
      await saveQueueRef.current;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const fullPatch = clone(latestWorkspacePatchRef.current);
        const fullPatchRecord = fullPatch as Record<keyof WorkspaceStatePatch, WorkspaceStatePatch[keyof WorkspaceStatePatch]>;
        const serialized = Object.fromEntries(Object.entries(fullPatch).map(([key, value]) => [key, JSON.stringify(value)]));
        const changedKeys = Object.keys(serialized).filter((key) => serverSnapshotRef.current[key] !== serialized[key]) as Array<keyof WorkspaceStatePatch>;
        if (!changedKeys.length) break;
        const patch = Object.fromEntries(changedKeys.map((key) => [key, fullPatchRecord[key]])) as WorkspaceStatePatch;
        const patchSerialized = Object.fromEntries(changedKeys.map((key) => [key, serialized[key]]));
        if (!await persistWorkspacePatch(patch, patchSerialized)) { logoutInProgressRef.current = false; setLogoutBusy(false); return; }
        if (attempt === 2 && WORKSPACE_PATCH_KEYS.some((key) => latestWorkspaceSerializedRef.current[key] !== serverSnapshotRef.current[key])) {
          throw new Error("退出前工作区仍在变化，请稍后重试");
        }
      }
    } catch (caught) {
      logoutInProgressRef.current = false;
      setLogoutBusy(false);
      const message = `退出前保存失败：${caught instanceof Error ? caught.message : String(caught)}`;
      setSaveStatus("error");
      setErrors((current) => current.includes(message) ? current : [...current, message]);
      setToast("尚未退出：请先重试保存");
      return;
    }
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("服务端退出失败");
      logoutInProgressRef.current = false;
      setWorkspaceReady(false);
      setSaveStatus("loading");
      setLogoutBusy(false);
      setAuth("signed-out");
    } catch (caught) {
      logoutInProgressRef.current = false;
      setLogoutBusy(false);
      const message = `退出失败：${caught instanceof Error ? caught.message : String(caught)}`;
      setErrors((current) => current.includes(message) ? current : [...current, message]);
      setToast("尚未退出，请重试");
    }
  }

  if (auth === "checking") return <main className="loading-screen"><span className="spinner" />正在验证会话…</main>;
  if (auth === "signed-out") return <LoginScreen onSuccess={() => { setWorkspaceReady(false); setWorkspaceLoadError(""); setSaveStatus("loading"); setAuth("signed-in"); }} />;
  if (!workspaceReady) return <main className="loading-screen"><span className={workspaceLoadError ? "" : "spinner"} />{workspaceLoadError ? <><strong>服务端工作区加载失败</strong><p>{workspaceLoadError}</p><button className="primary" onClick={() => { setWorkspaceLoadError(""); setSaveStatus("loading"); setWorkspaceReloadKey((value) => value + 1); }}>重试加载</button></> : "正在从项目服务器恢复工作区…"}</main>;
  if (logoutBusy) return <main className="loading-screen"><span className="spinner" />正在保存最后的工作区更改并安全退出…</main>;

  const busy = ["running", "paused", "stopping", "postprocessing"].includes(status);
  const modelBusy = busy || dailyBusy !== null || directChatBusy !== null;
  const statusLabel: Record<RunStatus, string> = { idle: "未运行", running: "运行中", paused: "已暂停", stopping: "正在停止", postprocessing: "结果生成中", completed: "已完成", error: "运行失败" };
  const actualEvaluatorCall = [...debugCalls].reverse().find((call) => call.type === "public_evaluation");
  const actualJsonRepairCall = [...debugCalls].reverse().find((call) => call.type === "json_repair");

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand"><div className="brand-mark">VC</div><div><h1>数字分身对话调试器 <span>MVP</span></h1><p>Venture Agent Conversation Workbench</p></div></div>
        <div className="header-actions">
          <span className={`api-pill ${apiState?.configured ? "ok" : "warn"}`}><i />{apiState?.configured ? apiState.model : apiState ? `缺少 ${apiState.missing.join(" / ")}` : "检查模型配置"}</span>
          <button className={`save-state ${saveStatus}`} onClick={() => saveStatus === "error" && handleSaveIssue()} disabled={saveStatus !== "error"}>{saveStatus === "saving" ? "保存到服务器中…" : saveConflict.length ? "服务器冲突 · 点击处理" : saveStatus === "error" ? "保存失败 · 点击重试" : "已保存到服务器"}</button>
          <button disabled={modelBusy} onClick={() => setRecordsOpen(true)}>模拟记录 <b>{records.length}</b></button>
          <button onClick={() => setVersionOpen(true)}>配置版本 <b>{versions.length}</b></button>
          <button onClick={() => setDebugDrawer(true)}>调试抽屉 <b>{allDebugCalls.length}</b></button>
          <button disabled={modelBusy} onClick={logout}>退出</button>
        </div>
      </header>

      <section className="top-workspace">
        <div className="tabbar">
          <div className="tabs">
            <button className={tab === "conversation" ? "active" : ""} onClick={() => setTab("conversation")}>对话 <span>{messages.length}</span></button>
            <button className={tab === "results" ? "active" : ""} onClick={() => setTab("results")}>结果 <span>{[publicResult, investorMemory, founderMemory].filter(Boolean).length}</span></button>
            <button className={tab === "daily" ? "active" : ""} onClick={() => setTab("daily")}>日报 <span>{Object.values(dailyReports).filter(Boolean).length}</span></button>
            <button className={tab === "debug" ? "active" : ""} onClick={() => setTab("debug")}>调试 <span>{allDebugCalls.length}</span></button>
          </div>
          <div className="run-state"><i className={status} />{statusLabel[status]}{messages.length > 0 && <span>· {Math.max(...messages.map((message) => message.round))} 轮</span>}</div>
        </div>

        {tab === "conversation" && <div className="conversation-layout">
          <aside className="controls">
            <div className="control-title"><strong>本次运行设置</strong><span>编辑仅影响下一次模拟</span></div>
            <div className="run-buttons">
              {!busy && <button className="primary" disabled={!workspacePersisted || dailyBusy !== null || directChatBusy !== null || Object.values(profileDirty).some(Boolean)} onClick={start}>▶ 开始模拟</button>}
              {status === "running" && <button onClick={() => { pauseRef.current = true; setStatus("paused"); }}>Ⅱ 暂停</button>}
              {status === "paused" && <button className="primary" onClick={() => { pauseRef.current = false; setStatus("running"); }}>▶ 继续</button>}
              {busy && <button className="danger" onClick={stop}>■ 停止</button>}
              {!busy && messages.length > 0 && <button disabled={!workspacePersisted || dailyBusy !== null || directChatBusy !== null || Object.values(profileDirty).some(Boolean)} onClick={rerunLastSnapshot}>↻ 按原快照重新生成</button>}
              <button disabled={dailyBusy !== null || directChatBusy !== null || (busy && status !== "paused")} onClick={reset}>重置</button>
            </div>
            <div className="run-settings-note">对话规则会写入任务层传给双方 Agent；“结果 / 记忆”开关由平台在对话后调度执行。</div>
            <div className="control-grid">
              <label>最大对话轮数<input type="number" min={1} max={20} value={config.settings.maxRounds} disabled={busy} onChange={(event) => persistConfig({ ...config, settings: { ...config.settings, maxRounds: Number(event.target.value) } })} /></label>
              <label>先发言<select value={config.settings.firstSpeaker} disabled={busy} onChange={(event) => persistConfig({ ...config, settings: { ...config.settings, firstSpeaker: event.target.value as AgentRole } })}><option value="investor">投资人</option><option value="founder">创业者</option></select></label>
              <label>单次最大 Token<input type="number" min={64} max={16000} value={config.settings.maxTokens} disabled={busy} onChange={(event) => persistConfig({ ...config, settings: { ...config.settings, maxTokens: Number(event.target.value) } })} /></label>
            </div>
            <div className="toggles">
              <Toggle label="允许提前结束" checked={config.settings.allowEarlyEnd} onChange={(value) => persistConfig({ ...config, settings: { ...config.settings, allowEarlyEnd: value } })} />
              <Toggle label="生成公共结果" checked={config.settings.generatePublicResult} onChange={(value) => persistConfig({ ...config, settings: { ...config.settings, generatePublicResult: value } })} />
              <Toggle label="生成双方私有记忆" checked={config.settings.generateMemories} onChange={(value) => persistConfig({ ...config, settings: { ...config.settings, generateMemories: value } })} />
            </div>
            <details className="price-settings"><summary>成本估算单价</summary><label>输入 $ / 1M<input type="number" min={0} step="0.01" value={config.settings.inputPricePerMillion} onChange={(event) => persistConfig({ ...config, settings: { ...config.settings, inputPricePerMillion: Number(event.target.value) } })} /></label><label>输出 $ / 1M<input type="number" min={0} step="0.01" value={config.settings.outputPricePerMillion} onChange={(event) => persistConfig({ ...config, settings: { ...config.settings, outputPricePerMillion: Number(event.target.value) } })} /></label></details>
            <div className="run-summary"><span>输入 <b>{totalStats.input}</b></span><span>输出 <b>{totalStats.output}</b></span><span>估算成本 <b>{money(totalStats.cost)}</b></span></div>
          </aside>
          <div className="conversation-pane"><Conversation messages={messages} runningRole={runningRole} status={status} />{errors.length > 0 && <div className="error-stack">{errors.map((error, index) => <div key={index}>! {error}</div>)}</div>}</div>
        </div>}

        {tab === "results" && <div className="results-layout">
          <details className="evaluator-config" open>
            <summary>
              <div><span className="evaluator-badge">评</span><strong>中立评估器提示词</strong><em>独立后处理节点 · 不参与双方对话</em></div>
              <div className="evaluator-summary-meta"><span>{config.evaluatorPrompt.length} 字符 · ≈{tokenEstimate(config.evaluatorPrompt)} tokens</span><b>{config.settings.generatePublicResult ? "已启用" : "未生成公共结果"}</b></div>
            </summary>
            <div className="evaluator-editor">
              <div className="evaluator-note">修改后自动保存，仅影响下一次模拟。公共结果调用只使用本提示词、双方用户层资料和完整对话。</div>
              <textarea value={config.evaluatorPrompt} onChange={(event) => persistConfig({ ...config, evaluatorPrompt: event.target.value })} />
              <div className="evaluator-actions">
                <button onClick={() => persistConfig({ ...config, evaluatorPrompt: DEFAULT_CONFIG.evaluatorPrompt })}>↺ 恢复默认</button>
                <button onClick={() => setPromptModal({ title: "中立评估器 · 当前将使用的提示词", content: config.evaluatorPrompt })}>查看当前提交提示词</button>
                <button disabled={!actualEvaluatorCall} onClick={() => actualEvaluatorCall && setPromptModal({ title: "中立评估器 · 本次实际完整请求", content: formatModelRequest(actualEvaluatorCall.messages) })}>查看本次完整请求</button>
              </div>
            </div>
          </details>
          <div className="postprocess-prompts">
            {(["investor", "founder"] as AgentRole[]).map((role) => {
              const actual = [...debugCalls].reverse().find((call) => call.type === `${role}_memory`);
              return <details className="evaluator-config" key={role}>
                <summary><div><span className="evaluator-badge">忆</span><strong>{ROLE_LABEL[role]}记忆更新提示词</strong><em>合并更新前记忆与本轮对话</em></div><div className="evaluator-summary-meta"><span>{config.memoryPrompts[role].length} 字符 · ≈{tokenEstimate(config.memoryPrompts[role])} tokens</span><b>{config.settings.generateMemories ? "已启用" : "未启用"}</b></div></summary>
                <div className="evaluator-editor"><div className="evaluator-note">这里控制对话后的长期记忆更新。记忆任务会替换 Agent 的原任务层，并把更新前记忆和完整对话作为请求消息提交。</div><textarea value={config.memoryPrompts[role]} onChange={(event) => persistConfig({ ...config, memoryPrompts: { ...config.memoryPrompts, [role]: event.target.value } })} /><div className="evaluator-actions"><button onClick={() => persistConfig({ ...config, memoryPrompts: { ...config.memoryPrompts, [role]: DEFAULT_CONFIG.memoryPrompts[role] } })}>↺ 恢复默认</button><button onClick={() => setPromptModal({ title: `${ROLE_LABEL[role]}记忆更新 · 当前完整系统提示词`, content: composeMemoryPrompt(config, role) })}>查看当前系统提示词</button><button disabled={!actual} onClick={() => actual && setPromptModal({ title: `${ROLE_LABEL[role]}记忆更新 · 本次实际完整请求`, content: formatModelRequest(actual.messages) })}>查看本次完整请求</button></div></div>
              </details>;
            })}
            <details className="evaluator-config">
              <summary><div><span className="evaluator-badge">修</span><strong>JSON 修复提示词</strong><em>仅在结构化输出首次解析失败时调用</em></div><div className="evaluator-summary-meta"><span>{config.jsonRepairPrompt.length} 字符 · ≈{tokenEstimate(config.jsonRepairPrompt)} tokens</span><b>按需</b></div></summary>
              <div className="evaluator-editor"><div className="evaluator-note">这是独立模型调用。它只能修复结构，不应创造业务事实；调用时会完整记录在调试页。</div><textarea value={config.jsonRepairPrompt} onChange={(event) => persistConfig({ ...config, jsonRepairPrompt: event.target.value })} /><div className="evaluator-actions"><button onClick={() => persistConfig({ ...config, jsonRepairPrompt: DEFAULT_CONFIG.jsonRepairPrompt })}>↺ 恢复默认</button><button onClick={() => setPromptModal({ title: "JSON 修复器 · 当前系统提示词", content: config.jsonRepairPrompt })}>查看当前系统提示词</button><button disabled={!actualJsonRepairCall} onClick={() => actualJsonRepairCall && setPromptModal({ title: "JSON 修复器 · 本次实际完整请求", content: formatModelRequest(actualJsonRepairCall.messages) })}>查看本次完整请求</button></div></div>
            </details>
          </div>
          <div className="results-grid">
            <JsonPanel title="公共匹配结果" value={publicResult} onChange={(value) => updateStoredResult("public", value)} error={rawErrors.public} disabled={modelBusy} displayKind="public_evaluation" />
            <JsonPanel title="投资人私有记忆" value={investorMemory} onChange={(value) => updateStoredResult("investorMemory", value)} error={rawErrors.investorMemory} disabled={modelBusy} displayKind="investor_memory" />
            <JsonPanel title="创业者私有记忆" value={founderMemory} onChange={(value) => updateStoredResult("founderMemory", value)} error={rawErrors.founderMemory} disabled={modelBusy} displayKind="founder_memory" />
          </div>
        </div>}
        {tab === "daily" && <div className="daily-layout">
          <div className="daily-intro"><div><strong>Agent 每日日报调试</strong><span>平台层、工具层、用户层复用下方 Agent 配置；日报会覆盖任务层，并把当前私有记忆注入动态层。</span></div><span>日报也会记录完整提示词、工具调用、原始输出与 Token</span></div>
          <div className="daily-grid">
            {(["investor", "founder"] as AgentRole[]).map((role) => {
              const report = config.dailyReport[role];
              const memory = role === "investor" ? investorMemory : founderMemory;
              const actual = [...debugCalls].reverse().find((call) => call.type === `${role}_daily_report`);
              const currentDailyPrompt = composeDailyPrompt(config, role, memory);
              return <section className={`daily-card ${role}`} key={role}>
                <div className="daily-card-head"><div><span>{role === "investor" ? "投" : "创"}</span><div><strong>{ROLE_LABEL[role]} Agent 日报</strong><em>{memory ? "已注入当前资料的私有记忆" : "当前资料无私有记忆，仍可测试空状态"}</em></div></div><button className="primary" disabled={!workspacePersisted || dailyBusy !== null || busy || directChatBusy !== null} onClick={() => generateDailyReport(role)}>{dailyBusy === role ? "生成中…" : "生成日报"}</button></div>
                <div className="daily-layer-map" aria-label={`${ROLE_LABEL[role]}日报五层提示词结构`}>
                  <span><b>1</b>平台层<em>复用</em></span><i />
                  <span><b>2</b>工具层<em>复用</em></span><i />
                  <span><b>3</b>用户层<em>资料·只读</em></span><i />
                  <span className="replaced"><b>4</b>任务层<em>日报替换</em></span><i />
                  <span className="replaced"><b>5</b>动态层<em>日报替换</em></span>
                </div>
                <label className="daily-prompt"><span>日报任务层 <em>替换原任务层</em></span><textarea value={report.taskPrompt} onChange={(event) => persistConfig({ ...config, dailyReport: { ...config.dailyReport, [role]: { ...report, taskPrompt: event.target.value } } })} /></label>
                <DailyVariantControl label="日报任务层" content={report.taskPrompt} variants={report.taskVariants} onContent={(value) => persistConfig({ ...config, dailyReport: { ...config.dailyReport, [role]: { ...report, taskPrompt: value } } })} onVariants={(value) => persistConfig({ ...config, dailyReport: { ...config.dailyReport, [role]: { ...report, taskVariants: value } } })} />
                <label className="daily-prompt"><span>日报动态层 <em>使用 {"{{memory}}"} 注入记忆</em></span><textarea value={report.dynamicPrompt} onChange={(event) => persistConfig({ ...config, dailyReport: { ...config.dailyReport, [role]: { ...report, dynamicPrompt: event.target.value } } })} /></label>
                <DailyVariantControl label="日报动态层" content={report.dynamicPrompt} variants={report.dynamicVariants} onContent={(value) => persistConfig({ ...config, dailyReport: { ...config.dailyReport, [role]: { ...report, dynamicPrompt: value } } })} onVariants={(value) => persistConfig({ ...config, dailyReport: { ...config.dailyReport, [role]: { ...report, dynamicVariants: value } } })} />
                <details className="daily-prompt-preview">
                  <summary><span>查看当前完整五层系统提示词</span><em>{currentDailyPrompt.length} 字符 · ≈{tokenEstimate(currentDailyPrompt)} tokens</em></summary>
                  <pre>{currentDailyPrompt}</pre>
                </details>
                <div className="daily-actions"><label>最大输出 Token<input type="number" min={64} max={16000} value={report.maxTokens} onChange={(event) => persistConfig({ ...config, dailyReport: { ...config.dailyReport, [role]: { ...report, maxTokens: Number(event.target.value) } } })} /></label><button onClick={() => setPromptModal({ title: `${ROLE_LABEL[role]}日报 · 当前完整五层系统提示词`, content: currentDailyPrompt })}>放大查看当前提示词</button><button disabled={!actual} onClick={() => actual && setPromptModal({ title: `${ROLE_LABEL[role]}日报 · 本次实际完整请求`, content: formatModelRequest(actual.messages) })}>查看本次完整请求</button><button onClick={() => persistConfig({ ...config, dailyReport: { ...config.dailyReport, [role]: clone(DEFAULT_CONFIG.dailyReport[role]) } })}>恢复默认</button></div>
                <JsonPanel title={`${ROLE_LABEL[role]}日报`} value={dailyReports[role]} onChange={(value) => updateStoredDailyReport(role, value)} disabled={modelBusy} displayKind={role === "investor" ? "investor_daily_report" : "founder_daily_report"} />
              </section>;
            })}
          </div>
          {errors.length > 0 && <div className="error-stack">{errors.map((error, index) => <div key={index}>! {error}</div>)}</div>}
        </div>}
        {tab === "debug" && <DebugList calls={allDebugCalls} />}
      </section>

      <section className="config-toolbar">
        <div><strong>Agent 配置与分层提示词</strong><span>提示词等自动保存；用户资料需点击保存后才同步用户层与 Agent Card</span></div>
        <div><button onClick={saveVersion}>＋ 保存命名版本</button><button onClick={() => downloadJson("venture-agent-config.json", config)}>⇩ 导出配置</button><label className="button-label">⇧ 导入配置<input type="file" accept="application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) importConfig(file); event.currentTarget.value = ""; }} /></label></div>
      </section>

      <section className="agents-grid">
        {(["investor", "founder"] as AgentRole[]).map((role) => {
          const profile = activeUserProfile(profiles, config, role);
          const fileIds = new Set(profile.fileIds);
          const profileFiles = agentFiles[role].filter((file) => fileIds.has(file.id));
          const profileThreads = directChats[role].threads.filter((thread) => thread.agentSnapshot.id === profile.id);
          const profileChatState: DirectChatRoleState = {
            activeThreadId: profileThreads.some((thread) => thread.id === directChats[role].activeThreadId) ? directChats[role].activeThreadId : profileThreads[0]?.id || null,
            threads: profileThreads,
          };
          return <AgentPanel
          key={`${role}-${config[role].id}-${profileFieldsKey(config[role].fields)}`}
          role={role}
          config={config}
          onConfig={(next) => persistAgentConfig(role, next)}
          memory={role === "investor" ? investorMemory : founderMemory}
          onMemory={(value) => updateStoredResult(role === "investor" ? "investorMemory" : "founderMemory", value)}
          files={profileFiles}
          filesDisabled={modelBusy || !workspacePersisted}
          onFilesChange={(files, uploadedIds) => handleAgentFilesChange(role, files, uploadedIds)}
          promptPreview={() => setPromptModal({ title: `${ROLE_LABEL[role]} Agent · 当前最终组合提示词`, content: composePrompt(config[role], config.settings) })}
          chatState={profileChatState}
          chatBusy={directChatBusy === role}
          chatDisabled={!workspacePersisted || busy || dailyBusy !== null || (directChatBusy !== null && directChatBusy !== role)}
          chatError={directChatErrors[role]}
          onNewChat={() => createDirectChat(role)}
          onSelectChat={(threadId) => selectDirectChat(role, threadId)}
          onDeleteChat={() => deleteDirectChat(role)}
          onSendChat={(content) => sendDirectChat(role, content)}
          onPreviewChatCall={(call) => setPromptModal({ title: `${ROLE_LABEL[role]}用户测试对话 · 本次实际完整请求与工具轨迹`, content: `${formatModelRequest(call.messages)}\n\n【工具调用轨迹】\n${JSON.stringify(call.toolCalls || [], null, 2)}` })}
          onPreviewChatPrompt={(thread) => setPromptModal({ title: `${ROLE_LABEL[role]}用户测试对话 · 创建时冻结的本 Agent 完整提示词`, content: formatModelRequest([{ role: "system", content: thread.promptSnapshot }]) })}
          profileOptions={profiles[role]}
          onSelectProfile={(profileId) => selectUserProfile(role, profileId)}
          onCreateProfile={() => createUserProfile(role)}
          onProfileDirty={setRoleProfileDirty}
          onSaveProfile={(fields) => saveProfileFields(role, fields)}
        />;
        })}
      </section>

      {promptModal && <div className="modal-backdrop" onMouseDown={() => setPromptModal(null)}><section className="modal prompt-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><p>实际请求预览</p><h2>{promptModal.title}</h2></div><button onClick={() => setPromptModal(null)}>×</button></div><pre>{promptModal.content}</pre><div className="modal-foot"><span>{promptModal.content.length} 字符 · ≈{tokenEstimate(promptModal.content)} tokens</span><button onClick={() => { copyText(promptModal.content); setToast("已复制完整提示词"); }}>复制完整提示词</button></div></section></div>}

      {versionOpen && <div className="modal-backdrop" onMouseDown={() => setVersionOpen(false)}><section className="modal list-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><p>SERVER VERSIONS</p><h2>配置版本</h2></div><button onClick={() => setVersionOpen(false)}>×</button></div><button className="primary" onClick={saveVersion}>＋ 保存当前配置</button><div className="saved-list">{versions.length ? versions.map((version) => <article key={version.id}><div><strong>{version.name}</strong><span>{new Date(version.createdAt).toLocaleString("zh-CN")}</span></div><div><button onClick={() => loadVersion(version)}>加载</button><button onClick={() => downloadJson(`${version.name}.json`, version.config)}>导出</button><button className="danger-text" onClick={() => setVersions((current) => current.filter((item) => item.id !== version.id))}>删除</button></div></article>) : <div className="empty-panel">还没有保存版本</div>}</div></section></div>}

      {recordsOpen && <div className="modal-backdrop" onMouseDown={() => setRecordsOpen(false)}><section className="modal records-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><p>SERVER RUN HISTORY</p><h2>最近模拟记录</h2></div><button onClick={() => setRecordsOpen(false)}>×</button></div><div className="saved-list">{records.length ? records.map((record) => <article key={record.conversationId}><div><strong>{record.configSnapshot.investor.fields.agentName} × {record.configSnapshot.founder.fields.agentName}</strong><span>{new Date(record.createdAt).toLocaleString("zh-CN")} · {record.messages.length} 条消息 · {record.endReason}</span><code>{record.conversationId}</code></div><div><button onClick={() => loadRecord(record)}>查看</button><button onClick={() => downloadJson(`${record.conversationId}.json`, record)}>导出</button></div></article>) : <div className="empty-panel">还没有模拟记录</div>}</div></section></div>}

      {debugDrawer && <><div className="drawer-backdrop" onClick={() => setDebugDrawer(false)} /><aside className="debug-drawer"><div className="modal-head"><div><p>MODEL CALL INSPECTOR</p><h2>调试抽屉</h2></div><button onClick={() => setDebugDrawer(false)}>×</button></div><DebugList calls={allDebugCalls} /></aside></>}
      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}
