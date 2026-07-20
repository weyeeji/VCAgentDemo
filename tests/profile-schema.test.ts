import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_USER_PROFILES,
  DEFAULT_CONFIG,
  DIRECT_CHAT_TASK_PROMPTS,
  FIELD_DEFINITIONS,
  buildAgentCard,
  composeDirectChatPrompt,
  normalizeProfileFields,
  selectiveDisclosureKey,
} from "../lib/defaults";
import { DEMO_SEED_FILES } from "../lib/demo-seed-manifest";

const roles = ["investor", "founder"] as const;

test("DOCX schema exposes exactly three visibility groups", () => {
  roles.forEach((role) => {
    assert.deepEqual(
      [...new Set(FIELD_DEFINITIONS[role].map((field) => field.visibility))].sort(),
      ["private", "public", "selective"],
    );
  });

  const status = FIELD_DEFINITIONS.investor.find((field) => field.key === "deploymentStatus");
  assert.deepEqual(status?.options, ["积极寻找投资机会", "审慎出手", "暂时不投"]);
  assert.equal(status?.visibility, "selective");
});

test("A, B and C presets only contain DOCX fields plus disclosure metadata", () => {
  roles.forEach((role) => {
    const allowed = new Set([
      "agentName",
      ...FIELD_DEFINITIONS[role].map((field) => field.key),
      ...FIELD_DEFINITIONS[role]
        .filter((field) => field.visibility === "selective")
        .map((field) => selectiveDisclosureKey(field.key)),
    ]);
    DEFAULT_USER_PROFILES[role].forEach((profile) => {
      assert.deepEqual(Object.keys(profile.fields).filter((key) => !allowed.has(key)), []);
      assert.deepEqual(normalizeProfileFields(role, profile.fields), profile.fields);
      assert.doesNotMatch(JSON.stringify(profile.fields), /资料提供者自报|未经核验/);
    });
  });
});

test("Agent Card publishes selective fields by default, allows opt-out, and excludes private fields", () => {
  const profile = structuredClone(DEFAULT_USER_PROFILES.investor[0]);
  let claims = buildAgentCard({
    id: profile.id,
    role: profile.role,
    fields: profile.fields,
    prompts: { platform: profile.dynamicLayer, tools: profile.dynamicLayer, user: profile.dynamicLayer, task: profile.dynamicLayer, dynamic: profile.dynamicLayer },
  }).publicIdentity.claims;
  assert.ok(claims.organization);
  assert.equal(claims.organizationSize, profile.fields.organizationSize);
  assert.equal(claims.decisionStyle, undefined);

  profile.fields.publish_organizationSize = "false";
  claims = buildAgentCard({
    id: profile.id,
    role: profile.role,
    fields: profile.fields,
    prompts: { platform: profile.dynamicLayer, tools: profile.dynamicLayer, user: profile.dynamicLayer, task: profile.dynamicLayer, dynamic: profile.dynamicLayer },
  }).publicIdentity.claims;
  assert.equal(claims.organizationSize, undefined);
  assert.equal(claims.decisionStyle, undefined);
});

test("invalid legacy choice values are removed instead of becoming extra options", () => {
  const normalized = normalizeProfileFields("investor", {
    agentName: "旧资料",
    deploymentStatus: "选择性出手",
    reportMode: "只报告认为有价值的项目",
    sectors: "人工智能&算力、旧赛道",
  });
  assert.equal(normalized.deploymentStatus, "");
  assert.equal(normalized.reportMode, "");
  assert.equal(normalized.sectors, "人工智能&算力");
  assert.equal(normalized.publish_deploymentStatus, "true");
});

test("小友智心 PDF is bound only to founder C", () => {
  const spec = DEMO_SEED_FILES.find((file) => file.pdfName === "小友智心介绍20260608.pdf");
  assert.equal(spec?.role, "founder");
  assert.equal(spec?.profileId, "founder-demo-003");
  assert.equal(DEFAULT_USER_PROFILES.investor[2].fileIds.length, 0);
  assert.deepEqual(DEFAULT_USER_PROFILES.founder[2].fileIds, [spec?.id]);
});

test("用户直聊任务层 replaces the normal dual-Agent task layer", () => {
  const agent = structuredClone(DEFAULT_CONFIG.founder);
  agent.prompts.task.content = "OLD_DUAL_AGENT_TASK_SHOULD_NOT_APPEAR";
  const prompt = composeDirectChatPrompt(agent, DEFAULT_CONFIG.settings, null, "CUSTOM_USER_DIRECT_TASK");
  assert.match(prompt, /\[任务层\]\nCUSTOM_USER_DIRECT_TASK/);
  assert.doesNotMatch(prompt, /OLD_DUAL_AGENT_TASK_SHOULD_NOT_APPEAR/);
  assert.match(prompt, /当前消息来自创建、配置和管理本 Agent 的用户/);
  assert.match(DIRECT_CHAT_TASK_PROMPTS.founder, /不得把用户当成投资人/);
  assert.match(DIRECT_CHAT_TASK_PROMPTS.investor, /不得把用户当成创业者/);
});
