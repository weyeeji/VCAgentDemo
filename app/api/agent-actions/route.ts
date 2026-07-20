import { isAuthenticated, isSameOrigin } from "@/lib/auth";
import { jsonBody, memoryScopeFromRequest, NO_STORE, resolveAgent } from "@/lib/agent-state-api";
import { AgentStateConflictError, commitAgentActions } from "@/lib/memory-store";
import type { AgentActionProposal } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "请求来源无效。" }, { status: 403, headers: NO_STORE });
  if (!(await isAuthenticated(request))) return Response.json({ error: "请重新登录。" }, { status: 401, headers: NO_STORE });
  try {
    const body = await jsonBody(request);
    const agent = resolveAgent(String(body.agentId || ""));
    if (!Array.isArray(body.actions)) throw new Error("actions 必须是数组。");
    const allowedTypes = new Set(["memory.create", "memory.update", "memory.archive", "task.create", "task.update", "task.cancel"]);
    const actions = body.actions.map((candidate, index) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`第 ${index + 1} 个行动结构无效。`);
      const action = candidate as Record<string, unknown>;
      if (typeof action.id !== "string" || !action.id.trim() || !allowedTypes.has(String(action.type))
        || typeof action.reason !== "string" || !action.input || typeof action.input !== "object" || Array.isArray(action.input)) {
        throw new Error(`第 ${index + 1} 个行动缺少必要字段。`);
      }
      return {
        id: action.id.slice(0, 200),
        type: action.type,
        reason: action.reason.slice(0, 2_000),
        ...(typeof action.memoryId === "string" ? { memoryId: action.memoryId } : {}),
        ...(typeof action.taskId === "string" ? { taskId: action.taskId } : {}),
        input: action.input,
      } as AgentActionProposal;
    });
    const sourceType = typeof body.sourceType === "string" ? body.sourceType.slice(0, 100) : "direct_chat";
    const sourceId = typeof body.sourceId === "string" ? body.sourceId.slice(0, 200) : null;
    const result = commitAgentActions(memoryScopeFromRequest(request), agent.id, agent.role, actions, sourceType, sourceId);
    return Response.json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (error) {
    const status = error instanceof AgentStateConflictError ? 409 : 400;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status, headers: NO_STORE });
  }
}

