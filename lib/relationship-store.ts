import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentRelationship, RelationshipRecentTurn } from "./types";

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "app.db");
const MAX_SUMMARY_CHARS = 12_000;
const MAX_RECENT_TURNS = 12;

declare global {
  var __ventureRelationshipDb: DatabaseSync | undefined;
}

type RelationshipRow = {
  id: string;
  scope_id: string;
  investor_agent_id: string;
  founder_agent_id: string;
  episode_count: number;
  last_conversation_id: string | null;
  summary: string;
  recent_turns_json: string;
  version: number;
  created_at: string;
  updated_at: string;
};

function db(): DatabaseSync {
  if (globalThis.__ventureRelationshipDb) return globalThis.__ventureRelationshipDb;
  mkdirSync(DATA_DIR, { recursive: true });
  const database = new DatabaseSync(DB_PATH);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_relationships (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      investor_agent_id TEXT NOT NULL,
      founder_agent_id TEXT NOT NULL,
      episode_count INTEGER NOT NULL DEFAULT 0,
      last_conversation_id TEXT,
      summary TEXT NOT NULL DEFAULT '',
      recent_turns_json TEXT NOT NULL DEFAULT '[]',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(scope_id, investor_agent_id, founder_agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_relationships_agents
      ON agent_relationships(scope_id, investor_agent_id, founder_agent_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS agent_relationship_episodes (
      conversation_id TEXT PRIMARY KEY,
      relationship_id TEXT NOT NULL,
      episode_number INTEGER NOT NULL,
      summary TEXT NOT NULL,
      recent_turns_json TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(relationship_id, episode_number)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_relationship_episodes_relationship
      ON agent_relationship_episodes(relationship_id, episode_number DESC);

    CREATE TABLE IF NOT EXISTS agent_relationship_scope_migrations (
      source_scope_id TEXT NOT NULL,
      target_scope_id TEXT NOT NULL,
      migrated_at TEXT NOT NULL,
      PRIMARY KEY(source_scope_id, target_scope_id)
    );
  `);
  globalThis.__ventureRelationshipDb = database;
  return database;
}

function now(): string {
  return new Date().toISOString();
}

function cleanId(value: string, label: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id)) throw new Error(`${label}无效。`);
  return id;
}

function cleanSummary(value: string): string {
  return value.replaceAll("\0", "").trim().slice(0, MAX_SUMMARY_CHARS);
}

function cleanRecentTurns(value: RelationshipRecentTurn[]): RelationshipRecentTurn[] {
  if (!Array.isArray(value)) throw new Error("recentTurns 必须是数组。");
  return value.slice(-MAX_RECENT_TURNS).map((turn) => {
    if (!turn || (turn.role !== "investor" && turn.role !== "founder")) throw new Error("历史发言角色无效。");
    const round = Number(turn.round);
    if (!Number.isInteger(round) || round < 1 || round > 10_000) throw new Error("历史发言轮次无效。");
    const createdAt = typeof turn.createdAt === "string" && Number.isFinite(Date.parse(turn.createdAt))
      ? new Date(Date.parse(turn.createdAt)).toISOString()
      : now();
    return {
      role: turn.role,
      agentName: String(turn.agentName || "").replaceAll("\0", "").trim().slice(0, 200),
      round,
      content: String(turn.content || "").replaceAll("\0", "").trim().slice(0, 2_000),
      createdAt,
    };
  }).filter((turn) => turn.content);
}

function parseRecentTurns(value: string): RelationshipRecentTurn[] {
  try {
    return cleanRecentTurns(JSON.parse(value) as RelationshipRecentTurn[]);
  } catch {
    return [];
  }
}

function fromRow(row: RelationshipRow): AgentRelationship {
  return {
    id: row.id,
    investorAgentId: row.investor_agent_id,
    founderAgentId: row.founder_agent_id,
    episodeCount: row.episode_count,
    lastConversationId: row.last_conversation_id,
    summary: row.summary,
    recentTurns: parseRecentTurns(row.recent_turns_json),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getRow(database: DatabaseSync, scopeId: string, investorAgentId: string, founderAgentId: string): RelationshipRow | null {
  return (database.prepare(`SELECT * FROM agent_relationships
    WHERE scope_id = ? AND investor_agent_id = ? AND founder_agent_id = ?`)
    .get(scopeId, investorAgentId, founderAgentId) as RelationshipRow | undefined) || null;
}

export function getRelationship(scopeId: string, investorAgentId: string, founderAgentId: string): AgentRelationship | null {
  const row = getRow(db(), cleanId(scopeId, "scopeId"), cleanId(investorAgentId, "investorAgentId"), cleanId(founderAgentId, "founderAgentId"));
  return row ? fromRow(row) : null;
}

export function migrateRelationshipScope(sourceScopeId: string, targetScopeId: string): void {
  if (sourceScopeId === targetScopeId) return;
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    const completed = database.prepare(`SELECT 1 FROM agent_relationship_scope_migrations
      WHERE source_scope_id = ? AND target_scope_id = ?`).get(sourceScopeId, targetScopeId);
    if (!completed) {
      database.prepare("UPDATE OR IGNORE agent_relationships SET scope_id = ? WHERE scope_id = ?")
        .run(targetScopeId, sourceScopeId);
      database.prepare(`INSERT INTO agent_relationship_scope_migrations (source_scope_id, target_scope_id, migrated_at)
        VALUES (?, ?, ?)`).run(sourceScopeId, targetScopeId, now());
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function ensureRelationship(scopeId: string, investorAgentId: string, founderAgentId: string): AgentRelationship {
  const normalizedScope = cleanId(scopeId, "scopeId");
  const investorId = cleanId(investorAgentId, "investorAgentId");
  const founderId = cleanId(founderAgentId, "founderAgentId");
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    let row = getRow(database, normalizedScope, investorId, founderId);
    if (!row) {
      const timestamp = now();
      database.prepare(`INSERT INTO agent_relationships
        (id, scope_id, investor_agent_id, founder_agent_id, episode_count, last_conversation_id,
          summary, recent_turns_json, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, NULL, '', '[]', 1, ?, ?)`).run(
          `relationship_${randomUUID()}`, normalizedScope, investorId, founderId, timestamp, timestamp,
        );
      row = getRow(database, normalizedScope, investorId, founderId);
    }
    database.exec("COMMIT");
    return fromRow(row!);
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function recordRelationshipEpisode(
  scopeId: string,
  investorAgentId: string,
  founderAgentId: string,
  input: {
    conversationId: string;
    summary: string;
    recentTurns: RelationshipRecentTurn[];
    completedAt: string;
  },
): AgentRelationship {
  const normalizedScope = cleanId(scopeId, "scopeId");
  const investorId = cleanId(investorAgentId, "investorAgentId");
  const founderId = cleanId(founderAgentId, "founderAgentId");
  const conversationId = cleanId(input.conversationId, "conversationId");
  const summary = cleanSummary(input.summary);
  const recentTurns = cleanRecentTurns(input.recentTurns);
  const completedAt = Number.isFinite(Date.parse(input.completedAt)) ? new Date(Date.parse(input.completedAt)).toISOString() : now();
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    let row = getRow(database, normalizedScope, investorId, founderId);
    if (!row) {
      const timestamp = now();
      database.prepare(`INSERT INTO agent_relationships
        (id, scope_id, investor_agent_id, founder_agent_id, episode_count, last_conversation_id,
          summary, recent_turns_json, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, NULL, '', '[]', 1, ?, ?)`).run(
          `relationship_${randomUUID()}`, normalizedScope, investorId, founderId, timestamp, timestamp,
        );
      row = getRow(database, normalizedScope, investorId, founderId);
    }
    const existing = database.prepare("SELECT conversation_id FROM agent_relationship_episodes WHERE conversation_id = ?")
      .get(conversationId) as { conversation_id: string } | undefined;
    if (!existing) {
      const episodeNumber = row!.episode_count + 1;
      const timestamp = now();
      database.prepare(`INSERT INTO agent_relationship_episodes
        (conversation_id, relationship_id, episode_number, summary, recent_turns_json, completed_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          conversationId, row!.id, episodeNumber, summary, JSON.stringify(recentTurns), completedAt, timestamp,
        );
      database.prepare(`UPDATE agent_relationships SET episode_count = ?, last_conversation_id = ?,
        summary = ?, recent_turns_json = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(
          episodeNumber, conversationId, summary, JSON.stringify(recentTurns), timestamp, row!.id,
        );
      row = getRow(database, normalizedScope, investorId, founderId);
    }
    database.exec("COMMIT");
    return fromRow(row!);
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
