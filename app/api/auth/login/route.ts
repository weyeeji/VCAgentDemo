import { canAttempt, clearFailures, createSessionToken, isSameOrigin, rateLimitKey, recordFailure, sessionCookie, verifyCredentials } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "请求来源无效。" }, { status: 403 });

  let payload: { username?: string; password?: string };
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "登录请求格式无效。" }, { status: 400 });
  }

  const username = String(payload.username || "").slice(0, 128);
  const password = String(payload.password || "").slice(0, 256);
  const key = rateLimitKey(request, username);
  const limit = canAttempt(key);
  if (!limit.allowed) {
    return Response.json(
      { error: `尝试次数过多，请在 ${limit.retryAfter} 秒后重试。` },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter), "Cache-Control": "no-store" } },
    );
  }
  if (!(await verifyCredentials(username, password))) {
    recordFailure(key);
    await new Promise((resolve) => setTimeout(resolve, 450));
    return Response.json({ error: "账号或密码不正确。" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  clearFailures(key);
  let token: string;
  try { token = await createSessionToken(username); }
  catch { return Response.json({ error: "服务端登录安全配置不完整。" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
  return Response.json(
    { ok: true, username },
    { headers: { "Set-Cookie": sessionCookie(token), "Cache-Control": "no-store" } },
  );
}
