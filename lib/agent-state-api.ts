import { getWorkspaceState } from "./workspace-store";
import type { AgentRole } from "./types";

export const NO_STORE = { "Cache-Control": "no-store" };
export const MEMORY_SCOPE_HEADER = "x-agent-memory-scope";

export function memoryScopeFromRequest(request: Request): string {
  const value = request.headers.get(MEMORY_SCOPE_HEADER)?.trim() || "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(value)) {
    throw new Error("缺少有效的 Agent Memory 作用域。");
  }
  return value;
}

export function resolveAgent(agentId: string): { id: string; role: AgentRole } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(agentId)) throw new Error("无效的 Agent ID。");
  const state = getWorkspaceState();
  for (const role of ["investor", "founder"] as const) {
    if (state.profiles[role].some((profile) => profile.id === agentId)) return { id: agentId, role };
  }
  throw new Error("Agent 不存在或尚未保存到工作区。");
}

export async function jsonBody(request: Request, maxChars = 200_000): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (raw.length > maxChars) throw new Error("请求内容过大。");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请求体必须是 JSON 对象。");
  return parsed as Record<string, unknown>;
}

