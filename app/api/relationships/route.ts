import { isAuthenticated, isSameOrigin } from "@/lib/auth";
import { jsonBody, memoryScopeFromRequest, NO_STORE, resolveAgent } from "@/lib/agent-state-api";
import { ensureRelationship, getRelationship, recordRelationshipEpisode } from "@/lib/relationship-store";
import type { RelationshipRecentTurn } from "@/lib/types";

export const runtime = "nodejs";

function resolvePair(investorAgentId: string, founderAgentId: string) {
  const investor = resolveAgent(investorAgentId);
  const founder = resolveAgent(founderAgentId);
  if (investor.role !== "investor" || founder.role !== "founder") throw new Error("Agent 角色与对接关系不匹配。");
  return { investor, founder };
}

export async function GET(request: Request) {
  if (!(await isAuthenticated(request))) return Response.json({ error: "请重新登录。" }, { status: 401, headers: NO_STORE });
  try {
    const url = new URL(request.url);
    const { investor, founder } = resolvePair(
      url.searchParams.get("investorAgentId") || "",
      url.searchParams.get("founderAgentId") || "",
    );
    const relationship = getRelationship(memoryScopeFromRequest(request), investor.id, founder.id);
    return Response.json({ relationship }, { headers: NO_STORE });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "请求来源无效。" }, { status: 403, headers: NO_STORE });
  if (!(await isAuthenticated(request))) return Response.json({ error: "请重新登录。" }, { status: 401, headers: NO_STORE });
  try {
    const body = await jsonBody(request, 100_000);
    const { investor, founder } = resolvePair(String(body.investorAgentId || ""), String(body.founderAgentId || ""));
    const scopeId = memoryScopeFromRequest(request);
    const action = String(body.action || "ensure");
    if (action === "ensure") {
      return Response.json({ relationship: ensureRelationship(scopeId, investor.id, founder.id) }, { headers: NO_STORE });
    }
    if (action !== "complete") throw new Error("不支持的关系操作。");
    if (!Array.isArray(body.recentTurns)) throw new Error("recentTurns 必须是数组。");
    const relationship = recordRelationshipEpisode(scopeId, investor.id, founder.id, {
      conversationId: String(body.conversationId || ""),
      summary: typeof body.summary === "string" ? body.summary : "",
      recentTurns: body.recentTurns as RelationshipRecentTurn[],
      completedAt: typeof body.completedAt === "string" ? body.completedAt : new Date().toISOString(),
    });
    return Response.json({ relationship }, { headers: NO_STORE });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400, headers: NO_STORE });
  }
}
