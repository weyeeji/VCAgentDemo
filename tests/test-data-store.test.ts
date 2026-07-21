import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "venture-agent-clear-"));
process.env.DATA_DIR = dataDir;

const memoryStore = await import("../lib/memory-store");
const relationshipStore = await import("../lib/relationship-store");
const { clearTestData } = await import("../lib/test-data-store");

after(() => rmSync(dataDir, { recursive: true, force: true }));

test("simulation cleanup preserves user-owned state and files are outside its scope", () => {
  const scopeId = "workspace-clear-simulation";
  const investorId = "investor-demo-001";
  const founderId = "founder-demo-001";
  memoryStore.commitAgentActions(scopeId, investorId, "investor", [{
    id: "sim-memory-action",
    type: "memory.create",
    reason: "模拟对话提取",
    input: { kind: "fact", title: "模拟记忆", content: "模拟生成" },
  }], "simulation", "sim-memory-batch");
  memoryStore.createMemory(scopeId, investorId, "investor", {
    kind: "note", title: "旧迁移记忆", content: "旧模拟结果", sourceType: "legacy_blob", sourceId: "legacy-memory",
  });
  const directMemory = memoryStore.createMemory(scopeId, investorId, "investor", {
    kind: "preference", title: "用户偏好", content: "用户直聊确认", sourceType: "direct_chat", sourceId: "direct-memory",
  });
  memoryStore.createTask(scopeId, founderId, "founder", {
    title: "模拟任务", sourceType: "simulation", sourceId: "sim-task",
  });
  const directTask = memoryStore.createTask(scopeId, founderId, "founder", {
    title: "用户任务", sourceType: "direct_chat", sourceId: "direct-task",
  });
  relationshipStore.recordRelationshipEpisode(scopeId, investorId, founderId, {
    conversationId: "clear-conversation-1",
    summary: "需要被清除的关系摘要",
    recentTurns: [],
    completedAt: "2026-07-21T00:00:00.000Z",
  });

  const result = clearTestData(scopeId, "simulation");
  assert.equal(result.relationships, 1);
  assert.equal(result.relationshipEpisodes, 1);
  assert.equal(result.memories, 2);
  assert.equal(result.tasks, 1);
  assert.equal(result.stateEvents, 3);
  assert.equal(result.actionBatches, 1);
  assert.equal(relationshipStore.getRelationship(scopeId, investorId, founderId), null);
  assert.deepEqual(memoryStore.listMemories(scopeId, investorId, { status: "all" }).map((item) => item.id), [directMemory.id]);
  assert.deepEqual(memoryStore.listTasks(scopeId, founderId, { status: "all" }).map((item) => item.id), [directTask.id]);
});

test("full Agent-state cleanup removes remaining memories and tasks", () => {
  const scopeId = "workspace-clear-all";
  memoryStore.createMemory(scopeId, "investor-demo-001", "investor", {
    kind: "decision", title: "手工决策", content: "也要清除", sourceType: "manual", sourceId: "manual-memory",
  });
  memoryStore.createTask(scopeId, "founder-demo-001", "founder", {
    title: "手工任务", sourceType: "manual", sourceId: "manual-task",
  });

  const result = clearTestData(scopeId, "all_agent_state");
  assert.equal(result.memories, 1);
  assert.equal(result.tasks, 1);
  assert.equal(memoryStore.listMemories(scopeId, "investor-demo-001", { status: "all" }).length, 0);
  assert.equal(memoryStore.listTasks(scopeId, "founder-demo-001", { status: "all" }).length, 0);
});
