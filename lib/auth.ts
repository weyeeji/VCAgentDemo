const encoder = new TextEncoder();
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

type Attempt = { count: number; resetAt: number };
const attempts = new Map<string, Attempt>();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function textToBase64Url(value: string): string {
  return bytesToBase64Url(encoder.encode(value));
}

async function hmac(value: string): Promise<string> {
  const secret = process.env.AUTH_SESSION_SECRET || "local-demo-change-this-secret-before-deploying";
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function safeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) mismatch |= left[i] ^ right[i];
  return mismatch === 0;
}

export function rateLimitKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

export function canAttempt(key: string): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 0, resetAt: now + ATTEMPT_WINDOW_MS });
    return { allowed: true, retryAfter: 0 };
  }
  return { allowed: current.count < MAX_ATTEMPTS, retryAfter: Math.ceil((current.resetAt - now) / 1000) };
}

export function recordFailure(key: string): void {
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) attempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
  else attempts.set(key, { ...current, count: current.count + 1 });
}

export function clearFailures(key: string): void {
  attempts.delete(key);
}

export async function verifyCredentials(username: string, password: string): Promise<boolean> {
  const expectedUsername = process.env.AUTH_USERNAME || "user";
  const expectedPassword = process.env.AUTH_PASSWORD || "test";
  const [actualUser, expectedUser, actualPassword, expectedPasswordHash] = await Promise.all([
    digest(username), digest(expectedUsername), digest(password), digest(expectedPassword),
  ]);
  return safeEqual(actualUser, expectedUser) && safeEqual(actualPassword, expectedPasswordHash);
}

export async function createSessionToken(username: string): Promise<string> {
  const payload = textToBase64Url(JSON.stringify({ sub: username, exp: Date.now() + 8 * 60 * 60 * 1000 }));
  return `${payload}.${await hmac(payload)}`;
}

export async function isAuthenticated(request: Request): Promise<boolean> {
  const cookie = request.headers.get("cookie") || "";
  const token = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("vc_session="))?.slice("vc_session=".length);
  if (!token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqual(encoder.encode(signature), encoder.encode(await hmac(payload)))) return false;
  try {
    const decoded = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/")));
    return typeof decoded.exp === "number" && decoded.exp > Date.now();
  } catch {
    return false;
  }
}

export function sessionCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `vc_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure}`;
}

export function clearSessionCookie(): string {
  return "vc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";
}
