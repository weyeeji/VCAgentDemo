import { createHash } from "node:crypto";
import { listMemories, listTasks } from "./memory-store";
import { renderWorkingContextPrompt } from "./memory-prompt";
import type { WorkingContextSnapshot } from "./types";

function relevantToCounterparty(item: { counterpartyId: string | null }, counterpartyId: string | null): boolean {
  return counterpartyId === null || item.counterpartyId === null || item.counterpartyId === counterpartyId;
}

export function buildWorkingContextSnapshot(
  scopeId: string,
  agentId: string,
  counterpartyId: string | null = null,
): WorkingContextSnapshot {
  const memories = listMemories(scopeId, agentId, { status: "active", limit: 500 })
    .filter((item) => relevantToCounterparty(item, counterpartyId));
  const tasks = listTasks(scopeId, agentId, { status: "active", limit: 500 })
    .filter((item) => relevantToCounterparty(item, counterpartyId));
  const versionSource = {
    agentId,
    counterpartyId,
    memories: memories.map((item) => [item.id, item.version, item.updatedAt]),
    tasks: tasks.map((item) => [item.id, item.version, item.updatedAt]),
  };
  const version = createHash("sha256").update(JSON.stringify(versionSource)).digest("hex").slice(0, 16);

  const promptText = renderWorkingContextPrompt({ version, memories, tasks });
  return {
    agentId,
    counterpartyId,
    generatedAt: new Date().toISOString(),
    version,
    memories,
    tasks,
    promptText,
  };
}
