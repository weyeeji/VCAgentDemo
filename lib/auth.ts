import { hashedAttemptKey } from "./auth-store";
export { canAttempt, clearFailures, recordFailure } from "./auth-store";

const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function textToBase64Url(value: string): string {
  return bytesToBase64Url(encoder.encode(value));
}

async function hmac(value: string): Promise<string> {
  const secret = sessionSecret();
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

function sessionSecret(): string {
  const configured = process.env.AUTH_SESSION_SECRET;
  if (process.env.NODE_ENV === "production" && (!configured || configured.length < 32 || configured.startsWith("replace-with"))) {
    throw new Error("生产环境必须配置至少 32 字符的 AUTH_SESSION_SECRET。");
  }
  return configured || "local-demo-change-this-secret-before-deploying";
}

export function rateLimitKey(request: Request, username: string): string {
  const trustProxy = process.env.TRUST_PROXY === "1";
  const client = trustProxy
    ? request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "proxy-unknown"
    : "direct-client";
  return hashedAttemptKey(`${client}\n${username.toLowerCase()}`);
}

export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const configured = process.env.APP_ORIGIN?.replace(/\/$/, "");
  if (configured && origin === configured) return true;
  if (process.env.TRUST_PROXY === "1") {
    const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
    const protocol = request.headers.get("x-forwarded-proto") || "https";
    return Boolean(host && origin === `${protocol}://${host}`);
  }
  const host = request.headers.get("host");
  if (host) return origin === `${new URL(request.url).protocol}//${host}`;
  return origin === new URL(request.url).origin;
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
  try {
    if (!payload || !signature || !safeEqual(encoder.encode(signature), encoder.encode(await hmac(payload)))) return false;
  } catch {
    return false;
  }
  try {
    const decoded = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/")));
    return typeof decoded.exp === "number" && decoded.exp > Date.now();
  } catch {
    return false;
  }
}

export function sessionCookie(token: string): string {
  const origin = process.env.APP_ORIGIN || "";
  const useSecure = process.env.NODE_ENV === "production" && origin.startsWith("https://");
  const secure = useSecure ? "; Secure" : "";
  return `vc_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure}`;
}

export function clearSessionCookie(): string {
  return "vc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";
}
