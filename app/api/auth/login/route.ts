import { canAttempt, clearFailures, createSessionToken, rateLimitKey, recordFailure, sessionCookie, verifyCredentials } from "@/lib/auth";

export async function POST(request: Request) {
  const key = rateLimitKey(request);
  const limit = canAttempt(key);
  if (!limit.allowed) {
    return Response.json(
      { error: `尝试次数过多，请在 ${limit.retryAfter} 秒后重试。` },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter), "Cache-Control": "no-store" } },
    );
  }

  let payload: { username?: string; password?: string };
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "登录请求格式无效。" }, { status: 400 });
  }

  const username = String(payload.username || "").slice(0, 128);
  const password = String(payload.password || "").slice(0, 256);
  if (!(await verifyCredentials(username, password))) {
    recordFailure(key);
    return Response.json({ error: "账号或密码不正确。" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  clearFailures(key);
  const token = await createSessionToken(username);
  return Response.json(
    { ok: true, username },
    { headers: { "Set-Cookie": sessionCookie(token), "Cache-Control": "no-store" } },
  );
}
