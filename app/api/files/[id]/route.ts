import { isAuthenticated, isSameOrigin } from "@/lib/auth";
import { deleteAgentFile, isAgentRole } from "@/lib/file-store";

export const runtime = "nodejs";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "请求来源无效。" }, { status: 403 });
  if (!(await isAuthenticated(request))) return Response.json({ error: "请重新登录。" }, { status: 401 });
  const role = new URL(request.url).searchParams.get("role");
  if (!isAgentRole(role)) return Response.json({ error: "无效的 Agent 角色。" }, { status: 400 });
  const { id } = await context.params;
  const deleted = await deleteAgentFile(role, id);
  return deleted ? Response.json({ ok: true }) : Response.json({ error: "文件不存在或不属于当前 Agent。" }, { status: 404 });
}
