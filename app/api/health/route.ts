import { isAuthenticated } from "@/lib/auth";

export async function GET(request: Request) {
  if (!(await isAuthenticated(request))) return Response.json({ error: "未登录" }, { status: 401 });
  const missing = [
    ["OPENAI_API_KEY", process.env.OPENAI_API_KEY],
    ["OPENAI_BASE_URL", process.env.OPENAI_BASE_URL],
    ["OPENAI_MODEL", process.env.OPENAI_MODEL],
  ].filter(([, value]) => !value).map(([name]) => name);
  return Response.json({ configured: missing.length === 0, missing, model: process.env.OPENAI_MODEL || null });
}
