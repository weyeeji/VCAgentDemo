import { isAuthenticated, isSameOrigin } from "@/lib/auth";
import { jsonBody, memoryScopeFromRequest, NO_STORE, resolveAgent } from "@/lib/agent-state-api";
import { AgentStateConflictError, archiveMemory, getMemory, updateMemory } from "@/lib/memory-store";
import type { MemoryKind, MemoryStatus, MemoryVerification } from "@/lib/types";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  if (!(await isAuthenticated(request))) return Response.json({ error: "请重新登录。" }, { status: 401, headers: NO_STORE });
  try {
    const agent = resolveAgent(new URL(request.url).searchParams.get("agentId") || "");
    const memory = getMemory(memoryScopeFromRequest(request), agent.id, (await context.params).id);
    if (!memory) return Response.json({ error: "记忆不存在。" }, { status: 404, headers: NO_STORE });
    return Response.json({ memory }, { headers: NO_STORE });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400, headers: NO_STORE });
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  if (!isSameOrigin(request)) return Response.json({ error: "请求来源无效。" }, { status: 403, headers: NO_STORE });
  if (!(await isAuthenticated(request))) return Response.json({ error: "请重新登录。" }, { status: 401, headers: NO_STORE });
  try {
    const body = await jsonBody(request);
    const agent = resolveAgent(String(body.agentId || ""));
    const memory = updateMemory(memoryScopeFromRequest(request), agent.id, (await context.params).id, {
      ...(body.kind === undefined ? {} : { kind: body.kind as MemoryKind }),
      ...(body.title === undefined ? {} : { title: body.title as string }),
      ...(body.content === undefined ? {} : { content: body.content as string }),
      ...(body.verification === undefined ? {} : { verification: body.verification as MemoryVerification }),
      ...(body.status === undefined ? {} : { status: body.status as MemoryStatus }),
      ...(body.priority === undefined ? {} : { priority: body.priority as number }),
      ...(body.counterpartyId === undefined ? {} : { counterpartyId: body.counterpartyId as string | null }),
      ...(body.metadata === undefined ? {} : { metadata: body.metadata as Record<string, unknown> }),
      ...(body.supersedesId === undefined ? {} : { supersedesId: body.supersedesId as string | null }),
      expectedVersion: body.expectedVersion as number | undefined,
    });
    return Response.json({ memory }, { headers: NO_STORE });
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
    const memory = archiveMemory(memoryScopeFromRequest(request), agent.id, (await context.params).id,
      expectedVersionRaw ? Number(expectedVersionRaw) : undefined);
    return Response.json({ memory }, { headers: NO_STORE });
  } catch (error) {
    const status = error instanceof AgentStateConflictError ? 409 : 400;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status, headers: NO_STORE });
  }
}

