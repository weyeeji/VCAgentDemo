"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_CONFIG,
  FIELD_DEFINITIONS,
  LAYER_LABELS,
  MEMORY_PROMPTS,
  composePrompt,
  deepCloneConfig,
  defaultLayer,
  formatProfile,
} from "@/lib/defaults";
import type {
  AgentProfile,
  AgentRole,
  AppConfig,
  DebugCall,
  LayerKey,
  SavedVersion,
  SimulationRecord,
  TurnControl,
  TurnMessage,
} from "@/lib/types";

const CONFIG_KEY = "vc-agent-debugger:config:v1";
const VERSION_KEY = "vc-agent-debugger:versions:v1";
const RECORD_KEY = "vc-agent-debugger:records:v1";
const ROLE_LABEL: Record<AgentRole, string> = { investor: "投资人", founder: "创业者" };

type RunStatus = "idle" | "running" | "paused" | "stopping" | "postprocessing" | "completed" | "error";
type TopTab = "conversation" | "results" | "debug";

function id(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
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

function JsonPanel({ title, value, onChange, error }: { title: string; value: unknown | null; onChange: (value: unknown) => void; error?: { raw: string; error: string } }) {
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
          <button onClick={() => { setDraft(rendered || error?.raw || "{}"); setEditing(!editing); }}>{editing ? "取消" : "编辑"}</button>
          <button disabled={!value && !error?.raw} onClick={() => copyText(rendered || error?.raw || "")}>复制</button>
          <button disabled={!value && !error?.raw} onClick={() => downloadJson(`${title}.json`, value ?? { raw: error?.raw, error: error?.error })}>下载</button>
        </div>
      </div>
      {error && <div className="inline-error"><strong>解析失败：</strong>{error.error}<details><summary>查看原始输出</summary><pre>{error.raw}</pre></details></div>}
      {!value && !error ? <div className="empty-panel">对话结束后在此生成</div> : editing ? (
        <div><textarea className="json-editor" value={draft} onChange={(event) => setDraft(event.target.value)} />{editError && <p className="field-error">{editError}</p>}<button className="primary small" onClick={save}>保存 JSON</button></div>
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
  const [open, setOpen] = useState(layerKey === "platform");
  const layer = agent.prompts[layerKey];
  const estimate = tokenEstimate(layer.content);
  return (
    <section className={`prompt-layer ${layer.enabled ? "" : "disabled"}`}>
      <div className="layer-head">
        <button className="layer-title" onClick={() => setOpen(!open)}><span>{open ? "⌄" : "›"}</span>{LAYER_LABELS[layerKey]}</button>
        <div className="layer-meta"><span>{layer.content.length} 字符 · ≈{estimate} tokens</span><button className={`tiny-toggle ${layer.enabled ? "on" : ""}`} onClick={() => onChange({ ...agent, prompts: { ...agent.prompts, [layerKey]: { ...layer, enabled: !layer.enabled } } })} aria-label={`${LAYER_LABELS[layerKey]}开关`}><span /></button></div>
      </div>
      {open && <div className="layer-body">
        <textarea value={layer.content} placeholder={layerKey === "dynamic" ? "当前为空；可手动注入实时状态或外部事件" : "输入提示词"} onChange={(event) => onChange({ ...agent, prompts: { ...agent.prompts, [layerKey]: { ...layer, content: event.target.value } } })} />
        <button className="text-button" onClick={() => onChange({ ...agent, prompts: { ...agent.prompts, [layerKey]: { ...layer, content: defaultLayer(role, layerKey) } } })}>↺ 恢复默认</button>
      </div>}
    </section>
  );
}

function AgentPanel({ role, config, onConfig, memory, onMemory, promptPreview }: {
  role: AgentRole;
  config: AppConfig;
  onConfig: (config: AppConfig) => void;
  memory: unknown | null;
  onMemory: (value: unknown) => void;
  promptPreview: () => void;
}) {
  const agent = config[role];
  const color = role === "investor" ? "indigo" : "teal";
  function update(agentValue: AgentProfile) { onConfig({ ...config, [role]: agentValue }); }
  return (
    <section className={`agent-panel ${color}`}>
      <div className="agent-panel-head">
        <div className={`agent-avatar ${color}`}>{role === "investor" ? "投" : "创"}</div>
        <div><p>{ROLE_LABEL[role]} AGENT</p><h2>{agent.fields.agentName}</h2></div>
        <button className="outline" onClick={promptPreview}>查看最终组合提示词</button>
      </div>
      <details open className="profile-section">
        <summary><span>Agent 基本信息</span><span>{FIELD_DEFINITIONS[role].length} 个字段</span></summary>
        <div className="field-grid">
          {FIELD_DEFINITIONS[role].map((field) => <label key={field.key} className={field.multiline ? "full" : ""}>{field.label}{field.multiline ? <textarea value={agent.fields[field.key] || ""} onChange={(event) => update({ ...agent, fields: { ...agent.fields, [field.key]: event.target.value } })} /> : <input value={agent.fields[field.key] || ""} onChange={(event) => update({ ...agent, fields: { ...agent.fields, [field.key]: event.target.value } })} />}</label>)}
        </div>
      </details>
      <div className="section-label"><span>五层提示词</span><span>按固定顺序组合</span></div>
      {(Object.keys(LAYER_LABELS) as LayerKey[]).map((key) => <PromptLayerEditor key={key} role={role} layerKey={key} agent={agent} onChange={update} />)}
      <div className="private-memory">
        <JsonPanel title={`${ROLE_LABEL[role]}私有记忆`} value={memory} onChange={onMemory} />
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
      <h4>完整系统提示词</h4><pre>{call.systemPrompt}</pre>
      <h4>层级开关</h4><pre>{JSON.stringify(call.layerStates, null, 2)}</pre>
      <h4>Agent 信息快照</h4><pre>{JSON.stringify(call.profileSnapshot, null, 2)}</pre>
      <h4>消息历史</h4><pre>{JSON.stringify(call.messages, null, 2)}</pre>
      <h4>原始模型返回</h4><pre>{call.rawResponse || "（无）"}</pre>
      <h4>解析结果</h4><pre>{JSON.stringify(call.parsedResult, null, 2)}</pre>
    </div>
  </details>)}</div>;
}

export default function DemoApp() {
  const [auth, setAuth] = useState<"checking" | "signed-out" | "signed-in">("checking");
  const [config, setConfig] = useState<AppConfig>(() => deepCloneConfig(DEFAULT_CONFIG));
  const [versions, setVersions] = useState<SavedVersion[]>([]);
  const [records, setRecords] = useState<SimulationRecord[]>([]);
  const [activeVersion, setActiveVersion] = useState<string | null>(null);
  const [tab, setTab] = useState<TopTab>("conversation");
  const [status, setStatus] = useState<RunStatus>("idle");
  const [messages, setMessages] = useState<TurnMessage[]>([]);
  const [debugCalls, setDebugCalls] = useState<DebugCall[]>([]);
  const [publicResult, setPublicResult] = useState<unknown | null>(null);
  const [investorMemory, setInvestorMemory] = useState<unknown | null>(null);
  const [founderMemory, setFounderMemory] = useState<unknown | null>(null);
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

  useEffect(() => {
    fetch("/api/auth/session").then((response) => {
      if (!response.ok) throw new Error();
      return response.json();
    }).then(() => setAuth("signed-in")).catch(() => setAuth("signed-out"));
    queueMicrotask(() => {
      try {
        const saved = localStorage.getItem(CONFIG_KEY);
        const savedVersions = localStorage.getItem(VERSION_KEY);
        const savedRecords = localStorage.getItem(RECORD_KEY);
        if (saved) setConfig(JSON.parse(saved));
        if (savedVersions) setVersions(JSON.parse(savedVersions));
        if (savedRecords) setRecords(JSON.parse(savedRecords));
      } catch {}
    });
  }, []);

  useEffect(() => { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); }, [config]);
  useEffect(() => { localStorage.setItem(VERSION_KEY, JSON.stringify(versions)); }, [versions]);
  useEffect(() => { localStorage.setItem(RECORD_KEY, JSON.stringify(records.slice(0, 20))); }, [records]);
  useEffect(() => {
    if (auth !== "signed-in") return;
    fetch("/api/health").then((response) => response.json()).then(setApiState).catch(() => setApiState({ configured: false, missing: ["无法连接服务端"], model: null }));
  }, [auth]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 1800);
    return () => clearTimeout(timer);
  }, [toast]);

  const totalStats = useMemo(() => messages.reduce((sum, message) => ({ input: sum.input + message.inputTokens, output: sum.output + message.outputTokens, cost: sum.cost + message.estimatedCost }), { input: 0, output: 0, cost: 0 }), [messages]);

  function persistConfig(next: AppConfig) { setConfig(next); }

  function newRecord(snapshot: AppConfig): SimulationRecord {
    return {
      conversationId: id("conv"), createdAt: new Date().toISOString(), completedAt: null,
      configVersion: activeVersion, configSnapshot: clone(snapshot),
      promptSnapshots: { investor: composePrompt(snapshot.investor, snapshot.settings), founder: composePrompt(snapshot.founder, snapshot.settings) },
      messages: [], results: { public: null, investorMemory: null, founderMemory: null, rawErrors: {} },
      debugCalls: [], stats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 }, endReason: null, errors: [],
    };
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
  }) {
    const started = Date.now();
    const startedAt = new Date().toISOString();
    const inputEstimate = params.messages.reduce((sum, message) => sum + tokenEstimate(message.content), 0);
    let raw = "";
    let parsed: unknown = null;
    let inputTokens = inputEstimate;
    let outputTokens = 0;
    let usageEstimated = true;
    let callError: string | null = null;
    abortRef.current = new AbortController();
    try {
      const response = await fetch("/api/model", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: params.messages, maxTokens: params.maxTokens }), signal: abortRef.current.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      raw = data.content;
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
      const ended = Date.now();
      const cost = inputTokens / 1_000_000 * params.snapshot.settings.inputPricePerMillion + outputTokens / 1_000_000 * params.snapshot.settings.outputPricePerMillion;
      const debug: DebugCall = {
        id: id("call"), type: params.type, actor: params.actor, round: params.round,
        systemPrompt: params.systemPrompt, layerStates: params.layerStates || {}, profileSnapshot: params.profile ?? null,
        messages: clone(params.messages), rawResponse: raw, parsedResult: parsed,
        startedAt, endedAt: new Date(ended).toISOString(), durationMs: ended - started,
        inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, usageEstimated, estimatedCost: cost,
        success: !callError, error: callError,
      };
      params.record.debugCalls.push(debug);
      setDebugCalls([...params.record.debugCalls]);
      abortRef.current = null;
    }
  }

  async function parseWithRepair(raw: string, context: string, record: SimulationRecord, snapshot: AppConfig): Promise<unknown> {
    try { return extractJson(raw); } catch (firstError) {
      const systemPrompt = "你是 JSON 修复器。把用户提供的内容修复成一个合法 JSON 对象，保留原意和字段；只输出 JSON，不得解释，不得补充事实。";
      const repairMessages = [{ role: "system" as const, content: systemPrompt }, { role: "user" as const, content: `目标：${context}\n\n待修复内容：\n${raw}` }];
      const repaired = await modelCall({ record, type: "json_repair", actor: "system", round: null, systemPrompt, messages: repairMessages, maxTokens: snapshot.settings.maxTokens, snapshot });
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
    const publicProfiles = `【投资人公开资料】\n${formatProfile("investor", snapshot.investor.fields)}\n\n【创业者公开资料】\n${formatProfile("founder", snapshot.founder.fields)}`;

    async function generateResult(kind: "public" | "investorMemory" | "founderMemory") {
      const isPublic = kind === "public";
      const role: AgentRole = kind === "founderMemory" ? "founder" : "investor";
      const systemPrompt = isPublic ? snapshot.evaluatorPrompt : `${composePrompt(snapshot[role], snapshot.settings)}\n\n[私有记忆生成要求]\n${MEMORY_PROMPTS[role]}`;
      const actor = isPublic ? "evaluator" as const : role;
      const type: DebugCall["type"] = isPublic ? "public_evaluation" : role === "investor" ? "investor_memory" : "founder_memory";
      const userContent = `${publicProfiles}\n\n【完整对话】\n${transcript}\n\nconversation_id: ${record.conversationId}\ninvestor_agent_id: ${snapshot.investor.id}\nfounder_agent_id: ${snapshot.founder.id}\nconversation_end_reason: ${record.endReason || "unknown"}`;
      try {
        const response = await modelCall({ record, type, actor, round: null, systemPrompt,
          layerStates: isPublic ? {} : Object.fromEntries(Object.entries(snapshot[role].prompts).map(([key, layer]) => [key, layer.enabled])),
          profile: isPublic ? null : snapshot[role].fields,
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }],
          maxTokens: Math.max(1200, snapshot.settings.maxTokens), snapshot,
        });
        const result = await parseWithRepair(response.raw, type, record, snapshot);
        record.results[kind] = result;
        if (kind === "public") setPublicResult(result);
        if (kind === "investorMemory") setInvestorMemory(result);
        if (kind === "founderMemory") setFounderMemory(result);
      } catch (caught: unknown) {
        const label = isPublic ? "公共结果" : role === "investor" ? "投资人记忆" : "创业者记忆";
        const error = `${label}生成失败：${caught instanceof Error ? caught.message : String(caught)}`;
        record.errors.push(error);
        record.results.rawErrors[kind] = { raw: rawFromError(caught), error };
        setErrors([...record.errors]);
        setRawErrors({ ...record.results.rawErrors });
      }
    }

    if (snapshot.settings.generatePublicResult) await generateResult("public");
    if (snapshot.settings.generateMemories) {
      await generateResult("investorMemory");
      await generateResult("founderMemory");
    }
  }

  async function runSimulation(snapshot: AppConfig) {
    const record = newRecord(snapshot);
    lastRunRef.current = snapshot;
    stopRef.current = false;
    pauseRef.current = false;
    setMessages([]); setDebugCalls([]); setPublicResult(null); setInvestorMemory(null); setFounderMemory(null); setRawErrors({}); setErrors([]); setTab("conversation");
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
              layerStates: Object.fromEntries(Object.entries(agent.prompts).map(([key, layer]) => [key, layer.enabled])), profile: clone(agent.fields),
              messages: apiMessages, maxTokens: snapshot.settings.maxTokens, snapshot,
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

  function start() {
    if (["running", "paused", "postprocessing"].includes(status)) return;
    runSimulation(clone(config));
  }

  function stop() {
    stopRef.current = true;
    pauseRef.current = false;
    setStatus("stopping");
    abortRef.current?.abort();
  }

  function reset() {
    if (["running", "paused", "postprocessing"].includes(status)) stop();
    setMessages([]); setDebugCalls([]); setPublicResult(null); setInvestorMemory(null); setFounderMemory(null); setRawErrors({}); setErrors([]); setStatus("idle");
  }

  function saveVersion() {
    const name = window.prompt("为当前配置命名", `配置 ${versions.length + 1}`)?.trim();
    if (!name) return;
    const version: SavedVersion = { id: id("version"), name, createdAt: new Date().toISOString(), config: clone(config) };
    setVersions((current) => [version, ...current]); setActiveVersion(version.id); setToast("配置版本已保存");
  }

  function importConfig(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!parsed?.investor?.prompts || !parsed?.founder?.prompts || !parsed?.settings) throw new Error("缺少必要字段");
        setConfig(parsed); setActiveVersion(null); setToast("配置已导入");
      } catch (caught) { setToast(`导入失败：${caught instanceof Error ? caught.message : "格式错误"}`); }
    };
    reader.readAsText(file);
  }

  function loadRecord(record: SimulationRecord) {
    setMessages(clone(record.messages)); setDebugCalls(clone(record.debugCalls)); setPublicResult(clone(record.results.public));
    setInvestorMemory(clone(record.results.investorMemory)); setFounderMemory(clone(record.results.founderMemory)); setRawErrors(clone(record.results.rawErrors));
    setErrors(clone(record.errors)); setStatus("completed"); setRecordsOpen(false); setTab("conversation");
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setAuth("signed-out");
  }

  if (auth === "checking") return <main className="loading-screen"><span className="spinner" />正在验证会话…</main>;
  if (auth === "signed-out") return <LoginScreen onSuccess={() => setAuth("signed-in")} />;

  const busy = ["running", "paused", "stopping", "postprocessing"].includes(status);
  const statusLabel: Record<RunStatus, string> = { idle: "未运行", running: "运行中", paused: "已暂停", stopping: "正在停止", postprocessing: "结果生成中", completed: "已完成", error: "运行失败" };
  const actualEvaluatorCall = [...debugCalls].reverse().find((call) => call.type === "public_evaluation");

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand"><div className="brand-mark">VC</div><div><h1>数字分身对话调试器 <span>MVP</span></h1><p>Venture Agent Conversation Workbench</p></div></div>
        <div className="header-actions">
          <span className={`api-pill ${apiState?.configured ? "ok" : "warn"}`}><i />{apiState?.configured ? apiState.model : apiState ? `缺少 ${apiState.missing.join(" / ")}` : "检查模型配置"}</span>
          <button onClick={() => setRecordsOpen(true)}>模拟记录 <b>{records.length}</b></button>
          <button onClick={() => setVersionOpen(true)}>配置版本 <b>{versions.length}</b></button>
          <button onClick={() => setDebugDrawer(true)}>调试抽屉 <b>{debugCalls.length}</b></button>
          <button onClick={logout}>退出</button>
        </div>
      </header>

      <section className="top-workspace">
        <div className="tabbar">
          <div className="tabs">
            <button className={tab === "conversation" ? "active" : ""} onClick={() => setTab("conversation")}>对话 <span>{messages.length}</span></button>
            <button className={tab === "results" ? "active" : ""} onClick={() => setTab("results")}>结果 <span>{[publicResult, investorMemory, founderMemory].filter(Boolean).length}</span></button>
            <button className={tab === "debug" ? "active" : ""} onClick={() => setTab("debug")}>调试 <span>{debugCalls.length}</span></button>
          </div>
          <div className="run-state"><i className={status} />{statusLabel[status]}{messages.length > 0 && <span>· {Math.max(...messages.map((message) => message.round))} 轮</span>}</div>
        </div>

        {tab === "conversation" && <div className="conversation-layout">
          <aside className="controls">
            <div className="control-title"><strong>运行控制</strong><span>编辑仅影响下一次模拟</span></div>
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
              {!busy && <button className="primary" onClick={start}>▶ 开始模拟</button>}
              {status === "running" && <button onClick={() => { pauseRef.current = true; setStatus("paused"); }}>Ⅱ 暂停</button>}
              {status === "paused" && <button className="primary" onClick={() => { pauseRef.current = false; setStatus("running"); }}>▶ 继续</button>}
              {busy && <button className="danger" onClick={stop}>■ 停止</button>}
              {!busy && messages.length > 0 && <button onClick={() => runSimulation(clone(lastRunRef.current || config))}>↻ 重新生成</button>}
              <button disabled={busy && status !== "paused"} onClick={reset}>重置</button>
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
              <div className="evaluator-note">修改后自动保存，仅影响下一次模拟。公共结果调用只使用本提示词、双方公开资料和完整对话。</div>
              <textarea value={config.evaluatorPrompt} onChange={(event) => persistConfig({ ...config, evaluatorPrompt: event.target.value })} />
              <div className="evaluator-actions">
                <button onClick={() => persistConfig({ ...config, evaluatorPrompt: DEFAULT_CONFIG.evaluatorPrompt })}>↺ 恢复默认</button>
                <button onClick={() => setPromptModal({ title: "中立评估器 · 当前将使用的提示词", content: config.evaluatorPrompt })}>查看当前提交提示词</button>
                <button disabled={!actualEvaluatorCall} onClick={() => actualEvaluatorCall && setPromptModal({ title: "中立评估器 · 本次运行实际提示词快照", content: actualEvaluatorCall.systemPrompt })}>查看本次实际提示词</button>
              </div>
            </div>
          </details>
          <div className="results-grid">
            <JsonPanel title="公共匹配结果" value={publicResult} onChange={setPublicResult} error={rawErrors.public} />
            <JsonPanel title="投资人私有记忆" value={investorMemory} onChange={setInvestorMemory} error={rawErrors.investorMemory} />
            <JsonPanel title="创业者私有记忆" value={founderMemory} onChange={setFounderMemory} error={rawErrors.founderMemory} />
          </div>
        </div>}
        {tab === "debug" && <DebugList calls={debugCalls} />}
      </section>

      <section className="config-toolbar">
        <div><strong>Agent 配置与分层提示词</strong><span>所有编辑自动保存至本地浏览器</span></div>
        <div><button onClick={saveVersion}>＋ 保存命名版本</button><button onClick={() => downloadJson("venture-agent-config.json", config)}>⇩ 导出配置</button><label className="button-label">⇧ 导入配置<input type="file" accept="application/json" onChange={(event) => event.target.files?.[0] && importConfig(event.target.files[0])} /></label></div>
      </section>

      <section className="agents-grid">
        <AgentPanel role="investor" config={config} onConfig={persistConfig} memory={investorMemory} onMemory={setInvestorMemory} promptPreview={() => setPromptModal({ title: "投资人 Agent · 当前最终组合提示词", content: composePrompt(config.investor, config.settings) })} />
        <AgentPanel role="founder" config={config} onConfig={persistConfig} memory={founderMemory} onMemory={setFounderMemory} promptPreview={() => setPromptModal({ title: "创业者 Agent · 当前最终组合提示词", content: composePrompt(config.founder, config.settings) })} />
      </section>

      {promptModal && <div className="modal-backdrop" onMouseDown={() => setPromptModal(null)}><section className="modal prompt-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><p>实际请求预览</p><h2>{promptModal.title}</h2></div><button onClick={() => setPromptModal(null)}>×</button></div><pre>{promptModal.content}</pre><div className="modal-foot"><span>{promptModal.content.length} 字符 · ≈{tokenEstimate(promptModal.content)} tokens</span><button onClick={() => { copyText(promptModal.content); setToast("已复制完整提示词"); }}>复制完整提示词</button></div></section></div>}

      {versionOpen && <div className="modal-backdrop" onMouseDown={() => setVersionOpen(false)}><section className="modal list-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><p>LOCAL VERSIONS</p><h2>配置版本</h2></div><button onClick={() => setVersionOpen(false)}>×</button></div><button className="primary" onClick={saveVersion}>＋ 保存当前配置</button><div className="saved-list">{versions.length ? versions.map((version) => <article key={version.id}><div><strong>{version.name}</strong><span>{new Date(version.createdAt).toLocaleString("zh-CN")}</span></div><div><button onClick={() => { setConfig(clone(version.config)); setActiveVersion(version.id); setVersionOpen(false); setToast("版本已加载"); }}>加载</button><button onClick={() => downloadJson(`${version.name}.json`, version.config)}>导出</button><button className="danger-text" onClick={() => setVersions((current) => current.filter((item) => item.id !== version.id))}>删除</button></div></article>) : <div className="empty-panel">还没有保存版本</div>}</div></section></div>}

      {recordsOpen && <div className="modal-backdrop" onMouseDown={() => setRecordsOpen(false)}><section className="modal records-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><p>LOCAL RUN HISTORY</p><h2>最近模拟记录</h2></div><button onClick={() => setRecordsOpen(false)}>×</button></div><div className="saved-list">{records.length ? records.map((record) => <article key={record.conversationId}><div><strong>{record.configSnapshot.investor.fields.agentName} × {record.configSnapshot.founder.fields.agentName}</strong><span>{new Date(record.createdAt).toLocaleString("zh-CN")} · {record.messages.length} 条消息 · {record.endReason}</span><code>{record.conversationId}</code></div><div><button onClick={() => loadRecord(record)}>查看</button><button onClick={() => downloadJson(`${record.conversationId}.json`, record)}>导出</button></div></article>) : <div className="empty-panel">还没有模拟记录</div>}</div></section></div>}

      {debugDrawer && <><div className="drawer-backdrop" onClick={() => setDebugDrawer(false)} /><aside className="debug-drawer"><div className="modal-head"><div><p>MODEL CALL INSPECTOR</p><h2>调试抽屉</h2></div><button onClick={() => setDebugDrawer(false)}>×</button></div><DebugList calls={debugCalls} /></aside></>}
      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}
