import { isAuthenticated, isSameOrigin } from "@/lib/auth";
import { jsonBody, memoryScopeFromRequest, NO_STORE, resolveAgent } from "@/lib/agent-state-api";
import { AgentStateConflictError, updateTask } from "@/lib/memory-store";
import type { AgentTaskStatus } from "@/lib/types";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  if (!isSameOrigin(request)) return Response.json({ error: "请求来源无效。" }, { status: 403, headers: NO_STORE });
  if (!(await isAuthenticated(request))) return Response.json({ error: "请重新登录。" }, { status: 401, headers: NO_STORE });
  try {
    const body = await jsonBody(request);
    const agent = resolveAgent(String(body.agentId || ""));
    const task = updateTask(memoryScopeFromRequest(request), agent.id, (await context.params).id, {
      ...(body.title === undefined ? {} : { title: body.title as string }),
      ...(body.description === undefined ? {} : { description: body.description as string }),
      ...(body.status === undefined ? {} : { status: body.status as AgentTaskStatus }),
      ...(body.priority === undefined ? {} : { priority: body.priority as number }),
      ...(body.dueAt === undefined ? {} : { dueAt: body.dueAt as string | null }),
      ...(body.counterpartyId === undefined ? {} : { counterpartyId: body.counterpartyId as string | null }),
      ...(body.sourceMemoryId === undefined ? {} : { sourceMemoryId: body.sourceMemoryId as string | null }),
      ...(body.metadata === undefined ? {} : { metadata: body.metadata as Record<string, unknown> }),
      expectedVersion: body.expectedVersion as number | undefined,
    });
    return Response.json({ task }, { headers: NO_STORE });
  } catch (error) {
    const status = error instanceof AgentStateConflictError ? 409 : 400;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status, headers: NO_STORE });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  if (!isSameOrigin(request)) return Response.json({ error: "请求来源无效。" }, { status: 403, headers: NO_STORE });
  if (!(await isAuthenticated(request))) return Response.json({ error: "请重新登录。" }, { status: 401, headers: NO_STORE });
  try {
    const url = new URL(request.url);
    const agent = resolveAgent(url.searchParams.get("agentId") || "");
    const expectedVersionRaw = url.searchParams.get("expectedVersion");
    const task = updateTask(memoryScopeFromRequest(request), agent.id, (await context.params).id, {
      status: "cancelled",
      expectedVersion: expectedVersionRaw ? Number(expectedVersionRaw) : undefined,
    });
    return Response.json({ task }, { headers: NO_STORE });
  } catch (error) {
    const status = error instanceof AgentStateConflictError ? 409 : 400;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status, headers: NO_STORE });
  }
}

