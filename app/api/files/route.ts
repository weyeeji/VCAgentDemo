import { isAuthenticated } from "@/lib/auth";
import { isAgentRole, listAgentFiles, storeAgentFile } from "@/lib/file-store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!(await isAuthenticated(request))) return Response.json({ error: "请重新登录。" }, { status: 401 });
  const role = new URL(request.url).searchParams.get("role");
  if (!isAgentRole(role)) return Response.json({ error: "无效的 Agent 角色。" }, { status: 400 });
  return Response.json({ files: await listAgentFiles(role) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!(await isAuthenticated(request))) return Response.json({ error: "请重新登录。" }, { status: 401 });
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 22 * 1024 * 1024) return Response.json({ error: "本次上传内容过大。" }, { status: 413 });
  try {
    const form = await request.formData();
    const role = form.get("role");
    if (!isAgentRole(role)) return Response.json({ error: "无效的 Agent 角色。" }, { status: 400 });
    const files = form.getAll("files").filter((item): item is File => item instanceof File);
    if (!files.length) return Response.json({ error: "请选择文件。" }, { status: 400 });
    if (files.length > 5) return Response.json({ error: "每次最多上传 5 个文件。" }, { status: 400 });
    const stored = [];
    for (const file of files) stored.push(await storeAgentFile(role, file));
    return Response.json({ files: stored }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
