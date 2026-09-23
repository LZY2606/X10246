import { createHash } from "node:crypto";
import type {
  EntityId,
  EventId,
  ProjectId,
  SourceRef,
} from "./types.js";

// 稳定、确定性的内容摘要（导入/导出前后一致，不依赖进程态）。
export function stableHash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJSON(value))
    .digest("hex");
}

// 键排序的规范化 JSON，保证同一内容产生同一哈希。
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJSON).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k]))
      .join(",") +
      "}"
  );
}

// 参数指纹：算法版本 + 规范化参数，决定派生结果是否需要重算。
export function parameterFingerprint(
  algorithmVersion: string,
  params: Record<string, unknown>,
): string {
  return algorithmVersion + ":" + stableHash(params).slice(0, 16);
}

export function asEntityId(s: string): EntityId {
  return s as EntityId;
}
export function asEventId(s: string): EventId {
  return s as EventId;
}
export function asProjectId(s: string): ProjectId {
  return s as ProjectId;
}

// 人类可读且稳定的领域 ID（前缀+短哈希），导出导入保持不变。
export function makeEntityId(kind: string, basis: unknown): EntityId {
  return asEntityId("ent_" + kind + "_" + stableHash(basis).slice(0, 12));
}

export function summarizeRefs(refs: SourceRef[]): string {
  return refs
    .map((r) => `${r.entityId}@v${r.version}[${r.contentHash.slice(0, 8)}]`)
    .join(",");
}
