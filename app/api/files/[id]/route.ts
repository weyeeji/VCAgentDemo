import { isAuthenticated, isSameOrigin } from "@/lib/auth";
import {
  canPreviewFileInline,
  contentTypeForFile,
  deleteAgentFile,
  isAgentRole,
  readAgentFile,
} from "@/lib/file-store";

export const runtime = "nodejs";

function contentDisposition(filename: string, download: boolean): string {
  const fallback = filename.replace(/["\\]/g, "_") || "download";
  const encoded = encodeURIComponent(filename);
  return `${download ? "attachment" : "inline"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await isAuthenticated(request))) return Response.json({ error: "请重新登录。" }, { status: 401 });
  const role = new URL(request.url).searchParams.get("role");
  if (!isAgentRole(role)) return Response.json({ error: "无效的 Agent 角色。" }, { status: 400 });
  const { id } = await context.params;
  const download = new URL(request.url).searchParams.get("download") === "1";
  const result = await readAgentFile(role, id);
  if (!result) return Response.json({ error: "文件不存在或不属于当前 Agent。" }, { status: 404 });

  const { record, buffer } = result;
  const inline = !download && canPreviewFileInline(record);
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": contentTypeForFile(record),
      "Content-Disposition": contentDisposition(record.originalName, !inline),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "请求来源无效。" }, { status: 403 });
  if (!(await isAuthenticated(request))) return Response.json({ error: "请重新登录。" }, { status: 401 });
  const role = new URL(request.url).searchParams.get("role");
  if (!isAgentRole(role)) return Response.json({ error: "无效的 Agent 角色。" }, { status: 400 });
  const { id } = await context.params;
  const deleted = await deleteAgentFile(role, id);
  return deleted ? Response.json({ ok: true }) : Response.json({ error: "文件不存在或不属于当前 Agent。" }, { status: 404 });
}
