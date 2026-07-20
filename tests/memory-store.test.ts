import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "venture-agent-memory-"));
process.env.DATA_DIR = dataDir;

const store = await import("../lib/memory-store");
const { buildWorkingContextSnapshot } = await import("../lib/memory-context");

after(() => rmSync(dataDir, { recursive: true, force: true }));

test("memory CRUD, idempotency and working-context projection", () => {
  const scopeId = "test-scope-crud";
  const agentId = "investor-demo-001";
  const memory = store.createMemory(scopeId, agentId, "investor", {
    kind: "decision",
    title: "跟进决策",
    content: "本周安排产品演示",
    verification: "confirmed",
    priority: 90,
    sourceType: "test",
    sourceId: "memory-1",
  });
  const duplicate = store.createMemory(scopeId, agentId, "investor", {
    kind: "note",
    title: "不应被写入",
    content: "同一来源应幂等",
    sourceType: "test",
    sourceId: "memory-1",
  });
  assert.equal(duplicate.id, memory.id);

  const updated = store.updateMemory(scopeId, agentId, memory.id, {
    content: "本周五前安排产品演示",
    expectedVersion: memory.version,
  });
  assert.equal(updated.version, 2);
  assert.throws(
    () => store.updateMemory(scopeId, agentId, memory.id, { content: "过期修改", expectedVersion: 1 }),
    store.AgentStateConflictError,
  );

  const task = store.createTask(scopeId, agentId, "investor", {
    title: "联系创业者确认时间",
    status: "todo",
    priority: 80,
    sourceType: "test",
    sourceId: "task-1",
  });
  const actions = [{
    id: "action-1",
    type: "task.update" as const,
    reason: "用户确认开始跟进",
    taskId: task.id,
    input: { status: "in_progress", expectedVersion: task.version },
  }];
  const firstCommit = store.commitAgentActions(scopeId, agentId, "investor", actions, "direct_chat", "turn-1");
  const duplicateCommit = store.commitAgentActions(scopeId, agentId, "investor", actions, "direct_chat", "turn-1");
  assert.equal(duplicateCommit.tasks[0]?.id, firstCommit.tasks[0]?.id);
  assert.equal(store.listTasks(scopeId, agentId, { status: "all" })[0]?.version, 2);

  const context = buildWorkingContextSnapshot(scopeId, agentId);
  assert.match(context.promptText, /本周五前安排产品演示/);
  assert.match(context.promptText, /in_progress/);
  assert.equal(context.memories.length, 1);
  assert.equal(context.tasks.length, 1);

  const archived = store.archiveMemory(scopeId, agentId, memory.id, updated.version);
  assert.equal(archived.status, "archived");
  assert.equal(store.listMemories(scopeId, agentId).length, 0);
  assert.equal(store.listMemories(scopeId, agentId, { status: "all" }).length, 1);
});

test("confirmed action batches roll back atomically", () => {
  const scopeId = "test-scope-transaction";
  const agentId = "founder-demo-001";
  const task = store.createTask(scopeId, agentId, "founder", {
    title: "准备补充材料",
    status: "todo",
    sourceType: "test",
    sourceId: "rollback-task",
  });

  assert.throws(() => store.commitAgentActions(scopeId, agentId, "founder", [
    {
      id: "action-valid",
      type: "task.update",
      reason: "先更新任务",
      taskId: task.id,
      input: { status: "in_progress", expectedVersion: task.version },
    },
    {
      id: "action-invalid",
      type: "memory.archive",
      reason: "模拟同批次失败",
      memoryId: "memory-does-not-exist",
      input: { expectedVersion: 1 },
    },
  ], "direct_chat", "rollback-turn"));

  const persisted = store.listTasks(scopeId, agentId, { status: "all" });
  assert.equal(persisted[0]?.status, "todo");
  assert.equal(persisted[0]?.version, 1);
});
