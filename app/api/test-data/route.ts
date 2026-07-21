import { isAuthenticated, isSameOrigin } from "@/lib/auth";
import { jsonBody, memoryScopeFromRequest, NO_STORE } from "@/lib/agent-state-api";
import { clearTestData, type TestDataClearMode } from "@/lib/test-data-store";

export const runtime = "nodejs";

export async function DELETE(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "请求来源无效。" }, { status: 403, headers: NO_STORE });
  if (!(await isAuthenticated(request))) return Response.json({ error: "请重新登录。" }, { status: 401, headers: NO_STORE });
  try {
    const body = await jsonBody(request);
    const mode = body.mode as TestDataClearMode;
    if (mode !== "simulation" && mode !== "all_agent_state") throw new Error("清除模式无效。");
    const result = clearTestData(memoryScopeFromRequest(request), mode);
    return Response.json({ ok: true, mode, result }, { headers: NO_STORE });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400, headers: NO_STORE });
  }
}
