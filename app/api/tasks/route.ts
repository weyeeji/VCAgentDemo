import { isAuthenticated, isSameOrigin } from "@/lib/auth";
import { jsonBody, memoryScopeFromRequest, NO_STORE, resolveAgent } from "@/lib/agent-state-api";
import { createTask, listTasks } from "@/lib/memory-store";
import type { AgentTaskStatus } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!(await isAuthenticated(request))) return Response.json({ error: "请重新登录。" }, { status: 401, headers: NO_STORE });
  try {
    const url = new URL(request.url);
    const agent = resolveAgent(url.searchParams.get("agentId") || "");
    const tasks = listTasks(memoryScopeFromRequest(request), agent.id, {
      status: (url.searchParams.get("status") || "all") as AgentTaskStatus | "active" | "all",
      limit: Number(url.searchParams.get("limit") || 200),
    });
    return Response.json({ tasks }, { headers: NO_STORE });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "请求来源无效。" }, { status: 403, headers: NO_STORE });
  if (!(await isAuthenticated(request))) return Response.json({ error: "请重新登录。" }, { status: 401, headers: NO_STORE });
  try {
    const body = await jsonBody(request);
    const agent = resolveAgent(String(body.agentId || ""));
    const task = createTask(memoryScopeFromRequest(request), agent.id, agent.role, {
      title: body.title as string,
      description: body.description as string | undefined,
      status: body.status as AgentTaskStatus | undefined,
      priority: body.priority as number | undefined,
      dueAt: body.dueAt as string | null | undefined,
      counterpartyId: body.counterpartyId as string | null | undefined,
      sourceMemoryId: body.sourceMemoryId as string | null | undefined,
      sourceType: body.sourceType as string | undefined,
      sourceId: body.sourceId as string | null | undefined,
      metadata: body.metadata as Record<string, unknown> | undefined,
    });
    return Response.json({ task }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400, headers: NO_STORE });
  }
}

