import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "venture-agent-memory-"));
process.env.DATA_DIR = dataDir;

const store = await import("../lib/memory-store");
const { buildWorkingContextSnapshot } = await import("../lib/memory-context");
const { renderWorkingContextPrompt, LEGACY_MEMORY_EXTRACTION_PLACEHOLDER } = await import("../lib/memory-prompt");

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

  const restored = store.commitAgentActions(scopeId, agentId, "investor", [{
    id: "restore-memory",
    type: "memory.restore",
    reason: "用户要求恢复",
    memoryId: archived.id,
    input: { expectedVersion: archived.version },
  }], "direct_chat", "restore-turn").memories[0];
  assert.equal(restored?.status, "active");
});

test("simulation memory actions stay unverified and cannot overwrite confirmed memory", () => {
  const scopeId = "test-scope-autonomous";
  const agentId = "investor-demo-001";
  const created = store.commitAgentActions(scopeId, agentId, "investor", [{
    id: "simulation-create",
    type: "memory.create",
    reason: "对方在模拟对话中自报",
    input: { kind: "fact", title: "项目阶段", content: "处于 Pre-A", verification: "confirmed" },
  }], "simulation", "simulation-1").memories[0];
  assert.equal(created?.verification, "unverified");

  const confirmed = store.createMemory(scopeId, agentId, "investor", {
    kind: "decision",
    title: "用户决策",
    content: "暂不跟进",
    verification: "confirmed",
  });
  assert.throws(() => store.commitAgentActions(scopeId, agentId, "investor", [{
    id: "simulation-overwrite",
    type: "memory.update",
    reason: "模拟对话推断",
    memoryId: confirmed.id,
    input: { content: "立即跟进", expectedVersion: confirmed.version },
  }], "simulation", "simulation-2"), /不能自动改写/);
});

test("legacy browser memory scope migrates once into the stable workspace scope", () => {
  const legacyScope = "browser-legacy-memory-scope";
  const stableScope = "workspace-default-v1";
  const agentId = "founder-demo-001";
  const legacy = store.createMemory(legacyScope, agentId, "founder", {
    kind: "preference",
    title: "沟通偏好",
    content: "优先异步沟通",
    verification: "confirmed",
    sourceType: "direct_chat",
    sourceId: "legacy-scope-turn",
  });

  store.migrateMemoryScope(legacyScope, stableScope);
  store.migrateMemoryScope(legacyScope, stableScope);

  assert.equal(store.listMemories(legacyScope, agentId, { status: "all" }).length, 0);
  assert.equal(store.listMemories(stableScope, agentId, { status: "all" })[0]?.id, legacy.id);
});

test("legacy memory stays readable in dialogue but is masked for incremental extraction", () => {
  const scopeId = "test-scope-legacy-projection";
  const agentId = "investor-demo-003";
  store.createMemory(scopeId, agentId, "investor", {
    kind: "note",
    title: "旧版整块私有记忆（已迁移）",
    content: JSON.stringify({ summary: "已与云禾智创完成初步对接" }),
    verification: "confirmed",
    sourceType: "legacy_blob",
    sourceId: "legacy-projection",
  });

  const context = buildWorkingContextSnapshot(scopeId, agentId);
  assert.match(context.promptText, /云禾智创/);
  assert.match(context.promptText, /不得向对接方泄露/);

  const ownerPrompt = renderWorkingContextPrompt(context, { audience: "owner" });
  assert.match(ownerPrompt, /创建者\/管理者/);
  assert.match(ownerPrompt, /云禾智创/);

  const extractionPrompt = renderWorkingContextPrompt(context, { includeLegacyContent: false, audience: "maintenance" });
  assert.doesNotMatch(extractionPrompt, /云禾智创/);
  assert.match(extractionPrompt, new RegExp(LEGACY_MEMORY_EXTRACTION_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
