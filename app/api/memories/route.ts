import { isAuthenticated, isSameOrigin } from "@/lib/auth";
import { jsonBody, memoryScopeFromRequest, NO_STORE, resolveAgent } from "@/lib/agent-state-api";
import { createMemory, listMemories } from "@/lib/memory-store";
import type { MemoryKind, MemoryStatus, MemoryVerification } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!(await isAuthenticated(request))) return Response.json({ error: "请重新登录。" }, { status: 401, headers: NO_STORE });
  try {
    const url = new URL(request.url);
    const agent = resolveAgent(url.searchParams.get("agentId") || "");
    const scopeId = memoryScopeFromRequest(request);
    const status = url.searchParams.get("status") || "active";
    const kind = url.searchParams.get("kind") || undefined;
    const counterparty = url.searchParams.has("counterpartyId") ? url.searchParams.get("counterpartyId") : undefined;
    const memories = listMemories(scopeId, agent.id, {
      status: status as MemoryStatus | "all",
      kind: kind as MemoryKind | undefined,
      counterpartyId: counterparty,
      query: url.searchParams.get("q") || undefined,
      limit: Number(url.searchParams.get("limit") || 200),
    });
    return Response.json({ memories }, { headers: NO_STORE });
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
    const memory = createMemory(memoryScopeFromRequest(request), agent.id, agent.role, {
      kind: body.kind as MemoryKind,
      title: body.title as string,
      content: body.content as string,
      verification: body.verification as MemoryVerification | undefined,
      priority: body.priority as number | undefined,
      counterpartyId: body.counterpartyId as string | null | undefined,
      sourceType: body.sourceType as string | undefined,
      sourceId: body.sourceId as string | null | undefined,
      metadata: body.metadata as Record<string, unknown> | undefined,
      supersedesId: body.supersedesId as string | null | undefined,
    });
    return Response.json({ memory }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400, headers: NO_STORE });
  }
}

