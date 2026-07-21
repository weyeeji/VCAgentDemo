import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "app.db");

export type TestDataClearMode = "simulation" | "all_agent_state";

export interface TestDataClearResult {
  relationships: number;
  relationshipEpisodes: number;
  memories: number;
  tasks: number;
  stateEvents: number;
  actionBatches: number;
}

function cleanScopeId(value: string): string {
  const scopeId = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(scopeId)) throw new Error("Agent Memory 作用域无效。");
  return scopeId;
}

/**
 * Clear generated test state without touching profiles, prompt versions or
 * uploaded files. memoryScopeFromRequest initializes the related schemas before
 * this function is called by the API route.
 */
export function clearTestData(scopeId: string, mode: TestDataClearMode): TestDataClearResult {
  const normalizedScope = cleanScopeId(scopeId);
  if (mode !== "simulation" && mode !== "all_agent_state") throw new Error("清除模式无效。");
  mkdirSync(DATA_DIR, { recursive: true });
  const database = new DatabaseSync(DB_PATH);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("BEGIN IMMEDIATE");
  try {
    const relationshipEpisodes = Number(database.prepare(`DELETE FROM agent_relationship_episodes
      WHERE relationship_id IN (SELECT id FROM agent_relationships WHERE scope_id = ?)`)
      .run(normalizedScope).changes);
    const relationships = Number(database.prepare("DELETE FROM agent_relationships WHERE scope_id = ?")
      .run(normalizedScope).changes);
    const sourceFilter = mode === "simulation" ? "AND source_type IN ('simulation', 'legacy_blob')" : "";

    // Remove audit rows before their entities so a later manual update event
    // cannot retain the content of an item that originated from a simulation.
    const stateEvents = mode === "simulation"
      ? Number(database.prepare(`DELETE FROM agent_state_events AS event
          WHERE event.scope_id = ? AND (
            event.source_type IN ('simulation', 'legacy_blob')
            OR (event.entity_type = 'memory' AND EXISTS (
              SELECT 1 FROM agent_memories AS memory
              WHERE memory.id = event.entity_id AND memory.scope_id = event.scope_id
                AND memory.source_type IN ('simulation', 'legacy_blob')
            ))
            OR (event.entity_type = 'task' AND EXISTS (
              SELECT 1 FROM agent_tasks AS task
              WHERE task.id = event.entity_id AND task.scope_id = event.scope_id
                AND task.source_type IN ('simulation', 'legacy_blob')
            ))
          )`).run(normalizedScope).changes)
      : Number(database.prepare("DELETE FROM agent_state_events WHERE scope_id = ?").run(normalizedScope).changes);
    const actionBatches = Number(database.prepare(`DELETE FROM agent_action_batches WHERE scope_id = ? ${sourceFilter}`)
      .run(normalizedScope).changes);
    const tasks = Number(database.prepare(`DELETE FROM agent_tasks WHERE scope_id = ? ${sourceFilter}`)
      .run(normalizedScope).changes);
    const memories = Number(database.prepare(`DELETE FROM agent_memories WHERE scope_id = ? ${sourceFilter}`)
      .run(normalizedScope).changes);

    database.exec("COMMIT");
    return { relationships, relationshipEpisodes, memories, tasks, stateEvents, actionBatches };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}
