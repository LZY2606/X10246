import type { LockClaim } from "./unwrap";

export interface LockConflict {
  lockId: string;
  conflictsWith: string;
  reason: string;
  targetKey: string;
}

/**
 * 局部锁定冲突检测（确定性，按 lockId 排序）：
 * - 同一像素被两个锁赋不同整周；
 * - 同一条边被两个 edge 锁赋不同偏移；
 * - 同一区域被两个 region 锁赋不同常量。
 * 冲突的锁双方都标记为 inactive（不能参与积分），并生成 lock_conflict 事件依据。
 */
export function detectLockConflicts(locks: LockClaim[]): { active: LockClaim[]; conflicts: LockConflict[] } {
  const conflicts: LockConflict[] = [];
  const conflictIds = new Set<string>();

  const groups = new Map<string, LockClaim[]>();
  for (const lock of locks) {
    const key =
      lock.scope === "pixel"
        ? `pixel:${lock.pixel}`
        : lock.scope === "edge"
          ? `edge:${lock.targetId}`
          : `region:${lock.regionId}`;
    const arr = groups.get(key) ?? [];
    arr.push(lock);
    groups.set(key, arr);
  }

  for (const [key, arr] of groups) {
    if (arr.length < 2) continue;
    const distinct = new Map<number, LockClaim>();
    for (const lock of arr.sort((a, b) => a.lockId.localeCompare(b.lockId))) {
      const existing = distinct.get(lock.k);
      if (existing === undefined) {
        distinct.set(lock.k, lock);
      }
    }
    if (distinct.size > 1) {
      const list = arr;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (list[i]!.k !== list[j]!.k) {
            conflicts.push({
              lockId: list[i]!.lockId,
              conflictsWith: list[j]!.lockId,
              reason: `局部锁定冲突：${key} 同时被赋予整周 ${list[i]!.k} 与 ${list[j]!.k}`,
              targetKey: key
            });
            conflictIds.add(list[i]!.lockId);
            conflictIds.add(list[j]!.lockId);
          }
        }
      }
    }
  }

  const active = locks.filter((l) => !conflictIds.has(l.lockId));
  return { active, conflicts };
}
