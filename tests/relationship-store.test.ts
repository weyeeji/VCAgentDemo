import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "venture-agent-relationship-"));
process.env.DATA_DIR = dataDir;

const store = await import("../lib/relationship-store");

after(() => rmSync(dataDir, { recursive: true, force: true }));

test("relationship episodes continue and completion is idempotent", () => {
  const scopeId = "relationship-test-scope";
  const investorId = "investor-demo-001";
  const founderId = "founder-demo-001";
  const initial = store.ensureRelationship(scopeId, investorId, founderId);
  assert.equal(initial.episodeCount, 0);
  assert.equal(initial.lastConversationId, null);

  const first = store.recordRelationshipEpisode(scopeId, investorId, founderId, {
    conversationId: "conv-relationship-1",
    summary: "双方约定后续补充客户数据。",
    recentTurns: [{
      role: "founder",
      agentName: "创业者",
      round: 2,
      content: "下次提供客户数据。",
      createdAt: "2026-07-20T00:00:00.000Z",
    }],
    completedAt: "2026-07-20T00:01:00.000Z",
  });
  assert.equal(first.episodeCount, 1);
  assert.equal(first.lastConversationId, "conv-relationship-1");
  assert.match(first.summary, /客户数据/);

  const duplicate = store.recordRelationshipEpisode(scopeId, investorId, founderId, {
    conversationId: "conv-relationship-1",
    summary: "不应覆盖",
    recentTurns: [],
    completedAt: "2026-07-20T00:02:00.000Z",
  });
  assert.equal(duplicate.episodeCount, 1);
  assert.match(duplicate.summary, /客户数据/);

  const second = store.recordRelationshipEpisode(scopeId, investorId, founderId, {
    conversationId: "conv-relationship-2",
    summary: "已收到客户数据。",
    recentTurns: [],
    completedAt: "2026-07-21T00:01:00.000Z",
  });
  assert.equal(second.episodeCount, 2);
  assert.equal(second.lastConversationId, "conv-relationship-2");
});

test("legacy relationship scope migrates into the stable workspace scope", () => {
  const sourceScope = "browser-relationship-scope";
  const targetScope = "workspace-default-v1";
  const investorId = "investor-demo-002";
  const founderId = "founder-demo-002";
  const source = store.ensureRelationship(sourceScope, investorId, founderId);

  store.migrateRelationshipScope(sourceScope, targetScope);
  store.migrateRelationshipScope(sourceScope, targetScope);

  assert.equal(store.getRelationship(sourceScope, investorId, founderId), null);
  assert.equal(store.getRelationship(targetScope, investorId, founderId)?.id, source.id);
});
