import { isAuthenticated } from "@/lib/auth";
import { memoryScopeFromRequest, NO_STORE, resolveAgent } from "@/lib/agent-state-api";
import { buildWorkingContextSnapshot } from "@/lib/memory-context";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!(await isAuthenticated(request))) return Response.json({ error: "请重新登录。" }, { status: 401, headers: NO_STORE });
  try {
    const url = new URL(request.url);
    const agent = resolveAgent(url.searchParams.get("agentId") || "");
    const counterpartyId = url.searchParams.get("counterpartyId");
    if (counterpartyId) resolveAgent(counterpartyId);
    const context = buildWorkingContextSnapshot(memoryScopeFromRequest(request), agent.id, counterpartyId || null);
    return Response.json({ context }, { headers: NO_STORE });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400, headers: NO_STORE });
  }
}

