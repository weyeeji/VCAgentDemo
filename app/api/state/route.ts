import { isAuthenticated, isSameOrigin } from "@/lib/auth";
import { WorkspaceStateConflictError, getWorkspaceState, saveWorkspaceState, validateWorkspacePatch } from "@/lib/workspace-store";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_REQUEST_CHARS = 24_000_000;

export async function GET(request: Request) {
  if (!(await isAuthenticated(request))) {
    return Response.json({ error: "请重新登录。" }, { status: 401, headers: NO_STORE });
  }
  try {
    return Response.json({ state: getWorkspaceState() }, { headers: NO_STORE });
  } catch (error) {
    return Response.json({ error: `读取服务端工作区失败：${error instanceof Error ? error.message : String(error)}` }, { status: 500, headers: NO_STORE });
  }
}

export async function PUT(request: Request) {
  if (!isSameOrigin(request)) {
    return Response.json({ error: "请求来源无效。" }, { status: 403, headers: NO_STORE });
  }
  if (!(await isAuthenticated(request))) {
    return Response.json({ error: "请重新登录。" }, { status: 401, headers: NO_STORE });
  }
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_REQUEST_CHARS) {
    return Response.json({ error: "保存内容过大。" }, { status: 413, headers: NO_STORE });
  }
  let patch;
  let expectedUpdatedAt: string | null;
  try {
    const raw = await request.text();
    if (raw.length > MAX_REQUEST_CHARS) return Response.json({ error: "保存内容过大。" }, { status: 413, headers: NO_STORE });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!Object.hasOwn(parsed, "expectedUpdatedAt") || (parsed.expectedUpdatedAt !== null && typeof parsed.expectedUpdatedAt !== "string")) {
      throw new Error("expectedUpdatedAt 必须是服务器最近返回的时间或 null。");
    }
    expectedUpdatedAt = parsed.expectedUpdatedAt as string | null;
    const { expectedUpdatedAt: _expectedUpdatedAt, ...statePatch } = parsed;
    void _expectedUpdatedAt;
    patch = validateWorkspacePatch(statePatch);
  } catch (error) {
    const message = error instanceof SyntaxError ? "请求体不是合法 JSON。" : error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 400, headers: NO_STORE });
  }
  try {
    const state = saveWorkspaceState(patch, expectedUpdatedAt);
    return Response.json({ ok: true, updatedAt: state.updatedAt }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof WorkspaceStateConflictError) {
      return Response.json({ error: error.message.trim(), state: error.currentState }, { status: 409, headers: NO_STORE });
    }
    return Response.json({ error: `保存服务端工作区失败：${error instanceof Error ? error.message : String(error)}` }, { status: 500, headers: NO_STORE });
  }
}
