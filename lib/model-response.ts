/**
 * Helpers for normalizing upstream chat-completion payloads and memory extraction JSON.
 */

export interface UpstreamChoiceMessage {
  content?: unknown;
  reasoning_content?: unknown;
  reasoning?: unknown;
  thinking?: unknown;
  tool_calls?: unknown;
}

export type ExtractedMemoryKind = "fact" | "preference" | "constraint" | "note";

export interface ExtractedMemoryDraft {
  kind: ExtractedMemoryKind;
  title: string;
  content: string;
  verification: "unverified" | "conflicted";
  priority: number;
  sourceTurns: unknown[];
}

/** Pull plain text from OpenAI-style content string or content-part arrays. */
export function extractAssistantContent(message: UpstreamChoiceMessage | undefined): string | null {
  if (!message) return null;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    const joined = message.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const entry = part as { type?: unknown; text?: unknown; content?: unknown };
        if (typeof entry.text === "string") return entry.text;
        if (typeof entry.content === "string") return entry.content;
        return "";
      })
      .join("");
    if (joined) return joined;
  }
  return null;
}

/** Prefer embedded JSON inside reasoning/thinking when the main content field is empty. */
export function reasoningFallbackContent(message: UpstreamChoiceMessage | undefined): string | null {
  if (!message) return null;
  const candidates = [message.reasoning_content, message.reasoning, message.thinking];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const reasoning = value.trim();
    if (!reasoning) continue;
    const first = reasoning.indexOf("{");
    const last = reasoning.lastIndexOf("}");
    if (first >= 0 && last > first) return reasoning.slice(first, last + 1);
    return reasoning;
  }
  return null;
}

/** Resolve the best available assistant text from an upstream choice message. */
export function resolveAssistantContent(message: UpstreamChoiceMessage | undefined): string | null {
  const content = extractAssistantContent(message);
  if (content?.trim()) return content;
  return reasoningFallbackContent(message);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function candidateList(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const record = asRecord(result);
  if (Array.isArray(record.memories)) return record.memories;
  if (Array.isArray(record.memory)) return record.memory;
  if (Array.isArray(record.items)) return record.items;
  if (typeof record.title === "string" && typeof record.content === "string") return [record];
  return [];
}

function normalizeKind(kind: unknown): ExtractedMemoryKind | null {
  const raw = String(kind ?? "").trim().toLowerCase();
  const mapped: Record<string, ExtractedMemoryKind> = {
    fact: "fact",
    事实: "fact",
    preference: "preference",
    偏好: "preference",
    constraint: "constraint",
    约束: "constraint",
    note: "note",
    备注: "note",
    笔记: "note",
    // 模拟提取不允许直接写 decision；降级为 note 以免丢信息。
    decision: "note",
    决策: "note",
  };
  return mapped[raw] ?? null;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Normalize model memory-extraction JSON into persistable drafts.
 * Accepts common shape variants and drops incomplete rows.
 */
export function normalizeExtractedMemories(result: unknown): ExtractedMemoryDraft[] {
  const drafts: ExtractedMemoryDraft[] = [];
  for (const candidate of candidateList(result).slice(0, 12)) {
    const item = asRecord(candidate);
    const kind = normalizeKind(item.kind);
    const title = readText(item.title) || readText(item.name) || readText(item.heading);
    const content = readText(item.content) || readText(item.text) || readText(item.summary) || readText(item.body);
    if (!kind || !title || !content) continue;
    const priorityValue = Number(item.priority);
    drafts.push({
      kind,
      title: title.slice(0, 300),
      content,
      verification: item.verification === "conflicted" ? "conflicted" : "unverified",
      priority: Number.isFinite(priorityValue) ? Math.min(100, Math.max(0, Math.round(priorityValue))) : 50,
      sourceTurns: Array.isArray(item.source_turns) ? item.source_turns
        : Array.isArray(item.sourceTurns) ? item.sourceTurns
          : [],
    });
  }
  return drafts;
}
