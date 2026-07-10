import { isAuthenticated } from "@/lib/auth";

export async function GET(request: Request) {
  const authenticated = await isAuthenticated(request);
  return Response.json({ authenticated }, { status: authenticated ? 200 : 401, headers: { "Cache-Control": "no-store" } });
}
