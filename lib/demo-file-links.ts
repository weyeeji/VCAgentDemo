import { DEMO_SEED_FILES } from "./demo-seed-manifest";
import type { AgentRole, UserProfileLibrary } from "./types";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const DEMO_FILE_IDS = new Set(DEMO_SEED_FILES.map((file) => file.id));

/** 把已入库的模拟 PDF 重新挂回对应 A/B 预设资料，修复旧数据里 fileIds 为空或挂错资料的问题。 */
export function attachPresetDemoFileIds(
  profiles: UserProfileLibrary,
  readyFileIds: ReadonlySet<string>,
  timestamp: string,
): UserProfileLibrary {
  const next = clone(profiles);
  (["investor", "founder"] as const).forEach((role) => {
    next[role] = next[role].map((profile) => ({
      ...profile,
      fileIds: profile.fileIds.filter((fileId) => !DEMO_FILE_IDS.has(fileId)),
    }));
  });

  let changed = false;
  for (const spec of DEMO_SEED_FILES) {
    if (!readyFileIds.has(spec.id)) continue;
    const index = next[spec.role].findIndex((profile) => profile.id === spec.profileId);
    if (index < 0) continue;
    const profile = next[spec.role][index];
    const fileIds = [...new Set([...profile.fileIds, spec.id])].slice(0, 20);
    if (JSON.stringify(fileIds) === JSON.stringify(profile.fileIds)) continue;
    next[spec.role][index] = { ...profile, fileIds, updatedAt: timestamp };
    changed = true;
  }

  if (!changed) {
    const before = JSON.stringify(profiles);
    const after = JSON.stringify(next);
    return before === after ? profiles : next;
  }
  return next;
}

export function listReadyDemoFileIdsForRole(role: AgentRole, readyFileIds: ReadonlySet<string>): string[] {
  return DEMO_SEED_FILES.filter((file) => file.role === role && readyFileIds.has(file.id)).map((file) => file.id);
}
