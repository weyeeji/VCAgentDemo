import { isAuthenticated } from "@/lib/auth";

interface ModelRequest {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  maxTokens: number;
}

interface UpstreamResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: unknown;
  model?: unknown;
  id?: unknown;
}

function error(stage: string, message: string, status = 500) {
  return Response.json({ error: `${stage}：${message}` }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!(await isAuthenticated(request))) return error("鉴权失败", "请重新登录。", 401);

  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey) return error("模型配置缺失", "服务端未配置 OPENAI_API_KEY。", 503);
  if (!baseUrl) return error("模型配置缺失", "服务端未配置 OPENAI_BASE_URL。", 503);
  if (!model) return error("模型配置缺失", "服务端未配置 OPENAI_MODEL。", 503);

  let body: ModelRequest;
  try {
    body = await request.json();
  } catch {
    return error("请求解析失败", "请求体不是合法 JSON。", 400);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) return error("请求校验失败", "messages 不能为空。", 400);

  const controller = new AbortController();
  const timeoutMs = Math.max(5_000, Number(process.env.OPENAI_TIMEOUT_MS || 90_000));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: body.messages,
        max_tokens: Math.min(16_000, Math.max(64, Number(body.maxTokens) || 800)),
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      let detail = raw.slice(0, 500);
      try {
        const parsed = JSON.parse(raw);
        detail = parsed?.error?.message || parsed?.message || detail;
      } catch {}
      return error("模型请求失败", `${response.status} ${detail}`, response.status >= 400 && response.status < 600 ? response.status : 502);
    }

    let data: UpstreamResponse;
    try {
      data = JSON.parse(raw);
    } catch {
      return error("模型响应解析失败", "上游服务返回了非 JSON 响应。", 502);
    }
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) return error("模型返回空内容", "未收到可用的消息内容。", 502);

    return Response.json(
      {
        content,
        usage: data.usage || null,
        model: typeof data.model === "string" ? data.model : model,
        requestId: typeof data.id === "string" ? data.id : response.headers.get("x-request-id") || null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (controller.signal.aborted) return error("模型请求超时", `超过 ${Math.round(timeoutMs / 1000)} 秒。`, 504);
    return error("网络请求失败", message, 502);
  } finally {
    clearTimeout(timer);
  }
}
