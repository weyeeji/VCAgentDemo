"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_CONFIG,
  FIELD_DEFINITIONS,
  LAYER_LABELS,
  composeDailyPrompt,
  composeMemoryPrompt,
  composePrompt,
  deepCloneConfig,
  defaultLayer,
  formatProfile,
} from "@/lib/defaults";
import type {
  AgentProfile,
  AgentFileRecord,
  AgentRole,
  AppConfig,
  DebugCall,
  LayerKey,
  FieldDefinition,
  PromptVariant,
  SavedVersion,
  SimulationRecord,
  TurnControl,
  TurnMessage,
  ToolExecutionTrace,
  WorkspaceState,
  WorkspaceStatePatch,
} from "@/lib/types";

const LEGACY_CONFIG_KEY = "vc-agent-debugger:config:v1";
const LEGACY_VERSION_KEY = "vc-agent-debugger:versions:v1";
const LEGACY_RECORD_KEY = "vc-agent-debugger:records:v1";
const LEGACY_STORAGE_KEYS = [LEGACY_CONFIG_KEY, LEGACY_VERSION_KEY, LEGACY_RECORD_KEY] as const;
const WORKSPACE_PATCH_KEYS = ["config", "versions", "records", "memories", "dailyReports", "activeVersion", "activeRecordId"] as const;
const ROLE_LABEL: Record<AgentRole, string> = { investor: "投资人", founder: "创业者" };

type RunStatus = "idle" | "running" | "paused" | "stopping" | "postprocessing" | "completed" | "error";
type TopTab = "conversation" | "results" | "daily" | "debug";
type SaveStatus = "loading" | "saved" | "saving" | "error";

function id(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
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
      || typeof candidate.id !== "string" || candidate.id.length > 200
      || typeof candidate.name !== "string" || candidate.name.length > 200
      || typeof candidate.createdAt !== "string"
      || !isConfigCandidate(candidate.config)) return [];
    try {
      return [{ id: candidate.id, name: candidate.name, createdAt: candidate.createdAt, config: migrateConfig(candidate.config) }];
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
  const callTypes = new Set(["investor_turn", "founder_turn", "public_evaluation", "investor_memory", "founder_memory", "investor_daily_report", "founder_daily_report", "json_repair"]);
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
      return [{ ...clone(record), configSnapshot: migrateConfig(record.configSnapshot) }];
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
    migrated[role].id = typeof migrated[role].id === "string" ? migrated[role].id : DEFAULT_CONFIG[role].id;
    migrated[role].role = role;
    migrated[role].fields = Object.fromEntries(Object.entries(migrated[role].fields).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    (Object.keys(LAYER_LABELS) as LayerKey[]).forEach((key) => {
      const fallback = DEFAULT_CONFIG[role].prompts[key];
      const layer = migrated[role].prompts[key];
      if (!layer || typeof layer !== "object") migrated[role].prompts[key] = clone(fallback);
      else {
        if (typeof layer.enabled !== "boolean") layer.enabled = fallback.enabled;
        if (typeof layer.content !== "string") layer.content = fallback.content;
        if (!Array.isArray(layer.variants)) layer.variants = [];
        else layer.variants = layer.variants.filter((variant) => isPlainObject(variant)
          && typeof variant.id === "string" && typeof variant.name === "string"
          && typeof variant.content === "string" && typeof variant.createdAt === "string");
      }
    });
    const toolLayer = migrated[role].prompts.tools;
    if (toolLayer?.content?.startsWith("当前版本没有可用的外部工具。不得虚构已查询数据库")) {
      toolLayer.content = DEFAULT_CONFIG[role].prompts.tools.content;
    }
    const platformLayer = migrated[role].prompts.platform;
    const legacyRoleMarker = role === "investor" ? "角色附加要求：你是投资人数字分身" : "角色附加要求：你是创业者数字分身";
    if (platformLayer?.content?.includes(legacyRoleMarker)) platformLayer.content = DEFAULT_CONFIG[role].prompts.platform.content;
    migrated[role].prompts.user.enabled = true;
    migrated[role].prompts.user.content = "";
  });
  if (typeof migrated.evaluatorPrompt !== "string" || !migrated.evaluatorPrompt) migrated.evaluatorPrompt = DEFAULT_CONFIG.evaluatorPrompt;
  else if (migrated.evaluatorPrompt.includes("双方公开资料")) migrated.evaluatorPrompt = migrated.evaluatorPrompt.replaceAll("双方公开资料", "双方用户层资料");
  if (!migrated.memoryPrompts || typeof migrated.memoryPrompts !== "object") migrated.memoryPrompts = clone(DEFAULT_CONFIG.memoryPrompts);
  if (typeof migrated.jsonRepairPrompt !== "string" || !migrated.jsonRepairPrompt) migrated.jsonRepairPrompt = DEFAULT_CONFIG.jsonRepairPrompt;
  if (!migrated.dailyReport || typeof migrated.dailyReport !== "object") migrated.dailyReport = clone(DEFAULT_CONFIG.dailyReport);
  (["investor", "founder"] as AgentRole[]).forEach((role) => {
    if (typeof migrated.memoryPrompts[role] !== "string" || !migrated.memoryPrompts[role]) migrated.memoryPrompts[role] = DEFAULT_CONFIG.memoryPrompts[role];
    migrated.dailyReport[role] = { ...clone(DEFAULT_CONFIG.dailyReport[role]), ...(migrated.dailyReport[role] || {}) };
    if (!Array.isArray(migrated.dailyReport[role].taskVariants)) migrated.dailyReport[role].taskVariants = [];
    if (!Array.isArray(migrated.dailyReport[role].dynamicVariants)) migrated.dailyReport[role].dynamicVariants = [];
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

function JsonPanel({ title, value, onChange, error, disabled = false }: { title: string; value: unknown | null; onChange: (value: unknown) => void; error?: { raw: string; error: string }; disabled?: boolean }) {
  const [mode, setMode] = useState<"formatted" | "raw">("formatted");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [editError, setEditError] = useState("");
  const rendered = value === null ? "" : mode === "formatted" ? JSON.stringify(value, null, 2) : JSON.stringify(value);

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
          <button onClick={() => setMode(mode === "formatted" ? "raw" : "formatted")}>{mode === "formatted" ? "原始" : "格式化"}</button>
          <button disabled={disabled} onClick={() => { setDraft(rendered || error?.raw || "{}"); setEditing(!editing); }}>{editing ? "取消" : "编辑"}</button>
          <button disabled={!value && !error?.raw} onClick={() => copyText(rendered || error?.raw || "")}>复制</button>
          <button disabled={!value && !error?.raw} onClick={() => downloadJson(`${title}.json`, value ?? { raw: error?.raw, error: error?.error })}>下载</button>
        </div>
      </div>
      {error && <div className="inline-error"><strong>解析失败：</strong>{error.error}<details><summary>查看原始输出</summary><pre>{error.raw}</pre></details></div>}
      {!value && !error ? <div className="empty-panel">对话结束后在此生成</div> : editing ? (
        <div><textarea className="json-editor" value={draft} disabled={disabled} onChange={(event) => setDraft(event.target.value)} />{editError && <p className="field-error">{editError}</p>}<button className="primary small" disabled={disabled} onClick={save}>保存 JSON</button></div>
      ) : value ? <pre className="json-view">{rendered}</pre> : null}
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
        <div className="readonly-note">用户层由上方资料实时生成，以下就是实际传给 Agent 的全部用户层内容。如需修改，请编辑上方资料字段。</div>
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

function AgentFilePanel({ role, files, disabled, onFilesChange }: {
  role: AgentRole;
  files: AgentFileRecord[];
  disabled: boolean;
  onFilesChange: (files: AgentFileRecord[]) => void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    const response = await fetch(`/api/files?role=${role}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取文件列表失败");
    onFilesChange(data.files || []);
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
      await refresh();
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
    <summary><div><span>私有文件库</span><em>仅{ROLE_LABEL[role]} Agent 可检索</em></div><b>{files.filter((file) => file.status === "ready").length} / 20</b></summary>
    <div className="agent-files-body">
      <label className={`file-drop ${disabled || working ? "disabled" : ""}`}>
        <input ref={inputRef} type="file" multiple accept=".pdf,.docx,.txt,.md,.markdown,.csv" disabled={disabled || working} onChange={(event) => upload(event.target.files)} />
        <span>{working ? "正在解析并建立索引…" : "＋ 上传 PDF、DOCX、TXT、Markdown 或 CSV"}</span>
        <small>单文件 ≤ 10MB · 每次最多 5 个 · 文件持久化在服务器 data/ 目录</small>
      </label>
      {disabled && <div className="files-run-note">模拟运行期间文件快照已冻结，结束后可继续上传或删除。</div>}
      {error && <div className="inline-error">{error}</div>}
      <div className="file-list">
        {files.length ? files.map((file) => <article key={file.id}>
          <div className={`file-icon ${file.status}`}>{file.originalName.split(".").pop()?.slice(0, 4).toUpperCase()}</div>
          <div className="file-info"><strong title={file.originalName}>{file.originalName}</strong><span>{formatBytes(file.size)} · {file.status === "ready" ? `${file.chunkCount} 个检索片段` : file.status === "processing" ? "处理中" : "解析失败"}</span>{file.error && <em>{file.error}</em>}</div>
          <span className={`file-status ${file.status}`}>{file.status === "ready" ? "可检索" : file.status === "processing" ? "处理中" : "失败"}</span>
          <button disabled={disabled || working} onClick={() => remove(file)}>删除</button>
        </article>) : <div className="empty-file-list">尚未上传文件。没有文件时，工具会返回空结果。</div>}
      </div>
    </div>
  </details>;
}

function AgentPanel({ role, config, onConfig, memory, onMemory, promptPreview, files, filesDisabled, onFilesChange }: {
  role: AgentRole;
  config: AppConfig;
  onConfig: (config: AppConfig) => void;
  memory: unknown | null;
  onMemory: (value: unknown) => void;
  promptPreview: () => void;
  files: AgentFileRecord[];
  filesDisabled: boolean;
  onFilesChange: (files: AgentFileRecord[]) => void;
}) {
  const agent = config[role];
  const color = role === "investor" ? "indigo" : "teal";
  const requiredFields = FIELD_DEFINITIONS[role].filter((field) => field.required);
  const optionalFields = FIELD_DEFINITIONS[role].filter((field) => !field.required);
  const requiredDone = requiredFields.filter((field) => agent.fields[field.key]?.trim()).length;
  const optionalDone = optionalFields.filter((field) => agent.fields[field.key]?.trim()).length;
  const completion = requiredFields.length ? Math.round(requiredDone / requiredFields.length * 100) : 100;
  function update(agentValue: AgentProfile) { onConfig({ ...config, [role]: agentValue }); }
  const renderField = (field: FieldDefinition) => <QuestionnaireField key={field.key} definition={field} value={agent.fields[field.key] || ""} onChange={(value) => update({ ...agent, fields: { ...agent.fields, [field.key]: value } })} />;
  return (
    <section className={`agent-panel ${color}`}>
      <div className="agent-panel-head">
        <div className={`agent-avatar ${color}`}>{role === "investor" ? "投" : "创"}</div>
        <div><p>{ROLE_LABEL[role]} AGENT</p><h2>{agent.fields.agentName}</h2></div>
        <button className="outline" onClick={promptPreview}>查看最终组合提示词</button>
      </div>
      <div className="profile-progress">
        <div><strong>基础资料完整度</strong><span>{completion}% · 选填已补充 {optionalDone} 项</span></div>
        <div className="progress-track" role="progressbar" aria-label={`${ROLE_LABEL[role]}基础资料完整度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={completion}><i style={{ width: `${completion}%` }} /></div>
        <p>{requiredDone === requiredFields.length ? "核心初筛资料已齐全；可继续用选填画像提升匹配和对话精度。" : `还有 ${requiredFields.length - requiredDone} 项核心资料未填，建议补齐后再运行正式初筛。`}</p>
      </div>
      <details open className="profile-section">
        <summary><span>注册问卷 · 基础必填</span><span>{requiredDone} / {requiredFields.length} 已填写</span></summary>
        <div className="questionnaire-note">所有已填写字段都会原样进入该 Agent 的用户层，并在会后提供给中立评估器和双方记忆更新节点，不经过大模型改写。请勿填写身份证、账户、客户合同原文等高敏信息。</div>
        <div className="field-grid">{requiredFields.map(renderField)}</div>
      </details>
      <details className="profile-section advanced-profile">
        <summary><span>高级画像 · 选填</span><span>{optionalFields.filter((field) => agent.fields[field.key]?.trim()).length} / {optionalFields.length} 已填写</span></summary>
        <div className="questionnaire-note">用于提高判断与表达的专业度，可逐步补全。需要证据或较敏感的材料请放对应私有文件库；单一共享账号目前不适合真实机密数据。</div>
        <div className="field-grid">{optionalFields.map(renderField)}</div>
      </details>
      <AgentFilePanel role={role} files={files} disabled={filesDisabled} onFilesChange={onFilesChange} />
      <div className="section-label"><span>五层提示词</span><span>按固定顺序组合</span></div>
      {(Object.keys(LAYER_LABELS) as LayerKey[]).map((key) => <PromptLayerEditor key={key} role={role} layerKey={key} agent={agent} onChange={update} />)}
      <div className="private-memory">
        <JsonPanel title={`${ROLE_LABEL[role]}私有记忆`} value={memory} onChange={onMemory} disabled={filesDisabled} />
      </div>
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
  const [versions, setVersions] = useState<SavedVersion[]>([]);
  const [records, setRecords] = useState<SimulationRecord[]>([]);
  const [agentFiles, setAgentFiles] = useState<Record<AgentRole, AgentFileRecord[]>>({ investor: [], founder: [] });
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

  const currentWorkspacePatch = useCallback((): WorkspaceStatePatch => {
    return {
      config,
      versions,
      records: records.slice(0, 20),
      memories: { investor: investorMemory, founder: founderMemory },
      dailyReports,
      activeVersion,
      activeRecordId,
    };
  }, [activeRecordId, activeVersion, config, dailyReports, founderMemory, investorMemory, records, versions]);

  const renderedWorkspacePatch = currentWorkspacePatch();
  latestWorkspacePatchRef.current = renderedWorkspacePatch;
  latestWorkspaceSerializedRef.current = Object.fromEntries(Object.entries(renderedWorkspacePatch).map(([key, value]) => [key, JSON.stringify(value)]));

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
        if (safe.has("versions")) { adoptServerSlice("versions", current.versions); setVersions(current.versions); }
        if (safe.has("records")) { const value = current.records.slice(0, 20); adoptServerSlice("records", value); setRecords(value); }
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
          const patch: WorkspaceStatePatch = {
            config: legacyConfig || migrateConfig(state.config),
            versions: legacyVersions || [],
            records: migratedRecords,
            memories: {
              investor: latest?.results.investorMemory ?? null,
              founder: latest?.results.founderMemory ?? null,
            },
            dailyReports: latest?.results.dailyReports ?? { investor: null, founder: null },
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
      const normalizedConfig = migrateConfig(state.config);
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

      setConfig(normalizedConfig);
      setVersions(serverVersions);
      setRecords(serverRecords);
      setActiveVersion(validActiveVersion);
      setActiveRecordId(activeRecord?.conversationId || null);
      setInvestorMemory(clone(memories.investor ?? null));
      setFounderMemory(clone(memories.founder ?? null));
      setDailyReports(clone(reports));
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
        versions: JSON.stringify(state.versions),
        records: JSON.stringify(state.records),
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
      if (!hasUnsavedChanges && !saveTimerRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", protectUnsavedChanges);
    return () => window.removeEventListener("beforeunload", protectUnsavedChanges);
  }, []);

  useEffect(() => {
    if (auth !== "signed-in") return;
    fetch("/api/health").then((response) => response.json()).then(setApiState).catch(() => setApiState({ configured: false, missing: ["无法连接服务端"], model: null }));
    Promise.all((["investor", "founder"] as AgentRole[]).map(async (role) => {
      const response = await fetch(`/api/files?role=${role}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取文件列表失败");
      return [role, data.files || []] as const;
    })).then((entries) => setAgentFiles(Object.fromEntries(entries) as Record<AgentRole, AgentFileRecord[]>)).catch((caught) => setErrors((current) => [...current, `文件库加载失败：${caught instanceof Error ? caught.message : String(caught)}`]));
  }, [auth]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 1800);
    return () => clearTimeout(timer);
  }, [toast]);

  const totalStats = useMemo(() => messages.reduce((sum, message) => ({ input: sum.input + message.inputTokens, output: sum.output + message.outputTokens, cost: sum.cost + message.estimatedCost }), { input: 0, output: 0, cost: 0 }), [messages]);

  function persistConfig(next: AppConfig) { setConfig(next); }

  function updateStoredResult(kind: "public" | "investorMemory" | "founderMemory", value: unknown) {
    if (kind === "public") setPublicResult(value);
    if (kind === "investorMemory") setInvestorMemory(value);
    if (kind === "founderMemory") setFounderMemory(value);
    if (!activeRecordId) return;
    setRecords((current) => current.map((record) => record.conversationId === activeRecordId
      ? { ...record, results: { ...record.results, [kind]: clone(value) } }
      : record));
  }

  function updateStoredDailyReport(role: AgentRole, value: unknown) {
    setDailyReports((current) => ({ ...current, [role]: value }));
    if (!activeRecordId) return;
    setRecords((current) => current.map((record) => record.conversationId === activeRecordId
      ? { ...record, results: { ...record.results, dailyReports: { ...record.results.dailyReports, [role]: clone(value) } } }
      : record));
  }

  function newRecord(snapshot: AppConfig, fileSnapshots: Record<AgentRole, AgentFileRecord[]>, memorySnapshots: Record<AgentRole, unknown | null>): SimulationRecord {
    return {
      conversationId: id("conv"), createdAt: new Date().toISOString(), completedAt: null,
      configVersion: activeVersion, configSnapshot: clone(snapshot),
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
    agentRole?: AgentRole; fileIds?: string[]; toolsEnabled?: boolean; recordProgress?: "replace" | "merge-debug";
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
      setDebugCalls([...params.record.debugCalls]);
      if (params.recordProgress === "merge-debug") mergeDebugRecordProgress(params.record);
      else saveRecordProgress(params.record);
      abortRef.current = null;
    }
  }

  async function parseWithRepair(raw: string, context: string, record: SimulationRecord, snapshot: AppConfig, recordProgress: "replace" | "merge-debug" = "replace"): Promise<unknown> {
    try { return extractJson(raw); } catch (firstError) {
      const systemPrompt = snapshot.jsonRepairPrompt;
      const repairMessages = [{ role: "system" as const, content: systemPrompt }, { role: "user" as const, content: `目标：${context}\n\n待修复内容：\n${raw}` }];
      const repaired = await modelCall({ record, type: "json_repair", actor: "system", round: null, systemPrompt, messages: repairMessages, maxTokens: snapshot.settings.maxTokens, snapshot, recordProgress });
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
      const previousMemory = isPublic ? "" : `\n\n【更新前的${ROLE_LABEL[role]}私有记忆】\n${record.memorySnapshots[role] == null ? "（暂无，首次创建）" : JSON.stringify(record.memorySnapshots[role], null, 2)}`;
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
        if (kind === "investorMemory") setInvestorMemory(result);
        if (kind === "founderMemory") setFounderMemory(result);
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
          const apiMessages = [{ role: "system" as const, content: systemPrompt }, ...history];
          if (!history.length) apiMessages.push({ role: "user", content: "请根据本次任务与资料开始对话，直接输出约定 JSON。" });
          else apiMessages.push({ role: "user", content: pendingEndFrom && pendingEndFrom !== role ? "对方建议结束。请给出最后一次有价值的回应，并在适当时确认结束。直接输出约定 JSON。" : "请回应对方最新发言，直接输出约定 JSON。" });
          const started = Date.now();
          try {
            const response = await modelCall({
              record, type: role === "investor" ? "investor_turn" : "founder_turn", actor: role, round, systemPrompt,
              layerStates: Object.fromEntries(Object.entries(agent.prompts).map(([key, layer]) => [key, key === "user" ? true : layer.enabled])), profile: clone(agent.fields),
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
    if (dailyBusy || ["running", "paused", "stopping", "postprocessing"].includes(status)) return;
    setDailyBusy(role);
    setErrors([]);
    const memory = role === "investor" ? investorMemory : founderMemory;
    const storedRecord = activeRecordId ? records.find((record) => record.conversationId === activeRecordId) : null;
    // When a daily report is attached to an existing simulation, start from
    // that complete record so modelCall's progress save cannot erase it.
    const scratch = storedRecord
      ? clone(storedRecord)
      : newRecord(clone(config), clone(agentFiles), { investor: clone(investorMemory), founder: clone(founderMemory) });
    const targetRecordId = activeRecordId || id("daily");
    scratch.conversationId = targetRecordId;
    if (!storedRecord) scratch.debugCalls = [];
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
        fileIds: agentFiles[role].filter((file) => file.status === "ready").map((file) => file.id),
        toolsEnabled: config[role].prompts.tools.enabled,
        recordProgress: "merge-debug",
      });
      const result = await parseWithRepair(response.raw, `${ROLE_LABEL[role]}日报`, scratch, config, "merge-debug");
      const latest = scratch.debugCalls[scratch.debugCalls.length - 1];
      if (latest) latest.parsedResult = result;
      generated = result;
      setDebugCalls(clone(scratch.debugCalls));
      setDailyReports((current) => ({ ...current, [role]: result }));
      setToast(`${ROLE_LABEL[role]}日报已生成`);
    } catch (caught) {
      generationError = `${ROLE_LABEL[role]}日报生成失败：${caught instanceof Error ? caught.message : String(caught)}`;
      setDebugCalls(clone(scratch.debugCalls));
      setErrors([generationError]);
    } finally {
      if (!scratch.completedAt) scratch.completedAt = new Date().toISOString();
      scratch.results.dailyReports = { ...clone(dailyReports), ...(generated === undefined ? {} : { [role]: clone(generated) }) };
      scratch.errors = generationError ? [generationError] : [];
      setRecords((current) => {
        const existing = current.find((record) => record.conversationId === targetRecordId);
        const saved = existing ? {
          ...existing,
          completedAt: scratch.completedAt,
          results: generated === undefined ? existing.results : {
            ...existing.results,
            dailyReports: { ...(existing.results.dailyReports || { investor: null, founder: null }), [role]: clone(generated) },
          },
          debugCalls: clone(scratch.debugCalls),
          errors: generationError ? [...existing.errors, generationError] : existing.errors,
        } : clone(scratch);
        return [saved, ...current.filter((record) => record.conversationId !== targetRecordId)].slice(0, 20);
      });
      if (!activeRecordId) {
        setActiveRecordId(targetRecordId);
        setStatus(generated === undefined ? "error" : "completed");
      }
      setDailyBusy(null);
    }
  }

  function start() {
    if (dailyBusy || ["running", "paused", "postprocessing"].includes(status)) return;
    runSimulation(clone(config), clone(agentFiles), { investor: clone(investorMemory), founder: clone(founderMemory) });
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
    const name = window.prompt("为当前配置命名", `配置 ${versions.length + 1}`)?.trim();
    if (!name) return;
    const version: SavedVersion = { id: id("version"), name, createdAt: new Date().toISOString(), config: clone(config) };
    setVersions((current) => [version, ...current].slice(0, 100)); setActiveVersion(version.id); setToast("配置版本已保存");
  }

  function importConfig(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!isConfigCandidate(parsed)) throw new Error("配置结构无效或资料字段不是文本");
        setConfig(migrateConfig(parsed)); setActiveVersion(null); setToast("配置已导入");
      } catch (caught) { setToast(`导入失败：${caught instanceof Error ? caught.message : "格式错误"}`); }
    };
    reader.readAsText(file);
  }

  function loadRecord(record: SimulationRecord) {
    setMessages(clone(record.messages)); setDebugCalls(clone(record.debugCalls)); setPublicResult(clone(record.results.public));
    setRawErrors(clone(record.results.rawErrors));
    setActiveRecordId(record.conversationId); setErrors(clone(record.errors)); setStatus("completed"); setRecordsOpen(false); setTab("conversation");
  }

  function handleSaveIssue() {
    if (saveConflict.length) {
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
    if (dailyBusy || ["running", "paused", "stopping", "postprocessing"].includes(status)) { setToast("请先结束当前模型任务再退出"); return; }
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
          <button disabled={busy || dailyBusy !== null} onClick={() => setRecordsOpen(true)}>模拟记录 <b>{records.length}</b></button>
          <button onClick={() => setVersionOpen(true)}>配置版本 <b>{versions.length}</b></button>
          <button onClick={() => setDebugDrawer(true)}>调试抽屉 <b>{debugCalls.length}</b></button>
          <button disabled={busy || dailyBusy !== null} onClick={logout}>退出</button>
        </div>
      </header>

      <section className="top-workspace">
        <div className="tabbar">
          <div className="tabs">
            <button className={tab === "conversation" ? "active" : ""} onClick={() => setTab("conversation")}>对话 <span>{messages.length}</span></button>
            <button className={tab === "results" ? "active" : ""} onClick={() => setTab("results")}>结果 <span>{[publicResult, investorMemory, founderMemory].filter(Boolean).length}</span></button>
            <button className={tab === "daily" ? "active" : ""} onClick={() => setTab("daily")}>日报 <span>{Object.values(dailyReports).filter(Boolean).length}</span></button>
            <button className={tab === "debug" ? "active" : ""} onClick={() => setTab("debug")}>调试 <span>{debugCalls.length}</span></button>
          </div>
          <div className="run-state"><i className={status} />{statusLabel[status]}{messages.length > 0 && <span>· {Math.max(...messages.map((message) => message.round))} 轮</span>}</div>
        </div>

        {tab === "conversation" && <div className="conversation-layout">
          <aside className="controls">
            <div className="control-title"><strong>本次运行设置</strong><span>编辑仅影响下一次模拟</span></div>
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
            <div className="run-buttons">
              {!busy && <button className="primary" disabled={dailyBusy !== null} onClick={start}>▶ 开始模拟</button>}
              {status === "running" && <button onClick={() => { pauseRef.current = true; setStatus("paused"); }}>Ⅱ 暂停</button>}
              {status === "paused" && <button className="primary" onClick={() => { pauseRef.current = false; setStatus("running"); }}>▶ 继续</button>}
              {busy && <button className="danger" onClick={stop}>■ 停止</button>}
              {!busy && messages.length > 0 && <button onClick={() => runSimulation(clone(lastRunRef.current || config), clone(lastRunFilesRef.current || agentFiles), clone(lastRunMemoriesRef.current || { investor: investorMemory, founder: founderMemory }))}>↻ 按原快照重新生成</button>}
              <button disabled={dailyBusy !== null || (busy && status !== "paused")} onClick={reset}>重置</button>
            </div>
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
            <JsonPanel title="公共匹配结果" value={publicResult} onChange={(value) => updateStoredResult("public", value)} error={rawErrors.public} disabled={busy || dailyBusy !== null} />
            <JsonPanel title="投资人私有记忆" value={investorMemory} onChange={(value) => updateStoredResult("investorMemory", value)} error={rawErrors.investorMemory} disabled={busy || dailyBusy !== null} />
            <JsonPanel title="创业者私有记忆" value={founderMemory} onChange={(value) => updateStoredResult("founderMemory", value)} error={rawErrors.founderMemory} disabled={busy || dailyBusy !== null} />
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
                <div className="daily-card-head"><div><span>{role === "investor" ? "投" : "创"}</span><div><strong>{ROLE_LABEL[role]} Agent 日报</strong><em>{memory ? "已注入当前私有记忆" : "当前无私有记忆，仍可测试空状态"}</em></div></div><button className="primary" disabled={dailyBusy !== null || busy} onClick={() => generateDailyReport(role)}>{dailyBusy === role ? "生成中…" : "生成日报"}</button></div>
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
                <JsonPanel title={`${ROLE_LABEL[role]}日报`} value={dailyReports[role]} onChange={(value) => updateStoredDailyReport(role, value)} disabled={busy || dailyBusy !== null} />
              </section>;
            })}
          </div>
          {errors.length > 0 && <div className="error-stack">{errors.map((error, index) => <div key={index}>! {error}</div>)}</div>}
        </div>}
        {tab === "debug" && <DebugList calls={debugCalls} />}
      </section>

      <section className="config-toolbar">
        <div><strong>Agent 配置与分层提示词</strong><span>配置、版本、记录、记忆与日报自动保存至项目服务器</span></div>
        <div><button onClick={saveVersion}>＋ 保存命名版本</button><button onClick={() => downloadJson("venture-agent-config.json", config)}>⇩ 导出配置</button><label className="button-label">⇧ 导入配置<input type="file" accept="application/json" onChange={(event) => event.target.files?.[0] && importConfig(event.target.files[0])} /></label></div>
      </section>

      <section className="agents-grid">
        <AgentPanel role="investor" config={config} onConfig={persistConfig} memory={investorMemory} onMemory={(value) => updateStoredResult("investorMemory", value)} files={agentFiles.investor} filesDisabled={busy || dailyBusy !== null} onFilesChange={(files) => setAgentFiles((current) => ({ ...current, investor: files }))} promptPreview={() => setPromptModal({ title: "投资人 Agent · 当前最终组合提示词", content: composePrompt(config.investor, config.settings) })} />
        <AgentPanel role="founder" config={config} onConfig={persistConfig} memory={founderMemory} onMemory={(value) => updateStoredResult("founderMemory", value)} files={agentFiles.founder} filesDisabled={busy || dailyBusy !== null} onFilesChange={(files) => setAgentFiles((current) => ({ ...current, founder: files }))} promptPreview={() => setPromptModal({ title: "创业者 Agent · 当前最终组合提示词", content: composePrompt(config.founder, config.settings) })} />
      </section>

      {promptModal && <div className="modal-backdrop" onMouseDown={() => setPromptModal(null)}><section className="modal prompt-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><p>实际请求预览</p><h2>{promptModal.title}</h2></div><button onClick={() => setPromptModal(null)}>×</button></div><pre>{promptModal.content}</pre><div className="modal-foot"><span>{promptModal.content.length} 字符 · ≈{tokenEstimate(promptModal.content)} tokens</span><button onClick={() => { copyText(promptModal.content); setToast("已复制完整提示词"); }}>复制完整提示词</button></div></section></div>}

      {versionOpen && <div className="modal-backdrop" onMouseDown={() => setVersionOpen(false)}><section className="modal list-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><p>SERVER VERSIONS</p><h2>配置版本</h2></div><button onClick={() => setVersionOpen(false)}>×</button></div><button className="primary" onClick={saveVersion}>＋ 保存当前配置</button><div className="saved-list">{versions.length ? versions.map((version) => <article key={version.id}><div><strong>{version.name}</strong><span>{new Date(version.createdAt).toLocaleString("zh-CN")}</span></div><div><button onClick={() => { setConfig(migrateConfig(version.config)); setActiveVersion(version.id); setVersionOpen(false); setToast("版本已加载"); }}>加载</button><button onClick={() => downloadJson(`${version.name}.json`, version.config)}>导出</button><button className="danger-text" onClick={() => setVersions((current) => current.filter((item) => item.id !== version.id))}>删除</button></div></article>) : <div className="empty-panel">还没有保存版本</div>}</div></section></div>}

      {recordsOpen && <div className="modal-backdrop" onMouseDown={() => setRecordsOpen(false)}><section className="modal records-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><p>SERVER RUN HISTORY</p><h2>最近模拟记录</h2></div><button onClick={() => setRecordsOpen(false)}>×</button></div><div className="saved-list">{records.length ? records.map((record) => <article key={record.conversationId}><div><strong>{record.configSnapshot.investor.fields.agentName} × {record.configSnapshot.founder.fields.agentName}</strong><span>{new Date(record.createdAt).toLocaleString("zh-CN")} · {record.messages.length} 条消息 · {record.endReason}</span><code>{record.conversationId}</code></div><div><button onClick={() => loadRecord(record)}>查看</button><button onClick={() => downloadJson(`${record.conversationId}.json`, record)}>导出</button></div></article>) : <div className="empty-panel">还没有模拟记录</div>}</div></section></div>}

      {debugDrawer && <><div className="drawer-backdrop" onClick={() => setDebugDrawer(false)} /><aside className="debug-drawer"><div className="modal-head"><div><p>MODEL CALL INSPECTOR</p><h2>调试抽屉</h2></div><button onClick={() => setDebugDrawer(false)}>×</button></div><DebugList calls={debugCalls} /></aside></>}
      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}
