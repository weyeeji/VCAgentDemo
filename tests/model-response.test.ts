import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeExtractedMemories,
  resolveAssistantContent,
} from "../lib/model-response";

test("resolveAssistantContent prefers content and falls back to reasoning JSON", () => {
  assert.equal(resolveAssistantContent({ content: "  {\"ok\":true}  " })?.trim(), "{\"ok\":true}");
  assert.equal(
    resolveAssistantContent({
      content: "",
      reasoning_content: "thinking...\n{\"message\":\"hi\",\"control\":{}}\nextra",
    }),
    "{\"message\":\"hi\",\"control\":{}}",
  );
  assert.equal(
    resolveAssistantContent({
      content: [{ type: "output_text", text: "{\"a\":1}" }],
    }),
    "{\"a\":1}",
  );
});

test("normalizeExtractedMemories accepts shape variants and maps decision to note", () => {
  const fromWrapped = normalizeExtractedMemories({
    memories: [
      { kind: "fact", title: "融资轮次", content: "正在进行 Pre-A", verification: "confirmed", priority: 80 },
      { kind: "decision", title: "建议跟进", content: "下周约会议", verification: "confirmed" },
      { kind: "事实", title: "中文类型", content: "内容" },
      { kind: "fact", title: "", content: "缺标题" },
    ],
  });
  assert.equal(fromWrapped.length, 3);
  assert.equal(fromWrapped[0]?.verification, "unverified");
  assert.equal(fromWrapped[1]?.kind, "note");
  assert.equal(fromWrapped[2]?.kind, "fact");

  const fromArray = normalizeExtractedMemories([
    { kind: "preference", name: "偏好标题", text: "偏好内容", priority: 120 },
  ]);
  assert.equal(fromArray.length, 1);
  assert.equal(fromArray[0]?.title, "偏好标题");
  assert.equal(fromArray[0]?.priority, 100);

  assert.deepEqual(normalizeExtractedMemories({ memories: [] }), []);
});
