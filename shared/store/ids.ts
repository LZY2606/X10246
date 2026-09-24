import type { InputKind } from '../domain/types.js';

/** 稳定实体身份：同一逻辑输入跨版本共用 id */
export function inputEntityId(kind: InputKind, logicalKey?: string): string {
  return logicalKey ? `input:${kind}:${logicalKey}` : `input:${kind}`;
}
export function derivedEntityId(kind: string, fingerprint: string): string {
  return `derived:${kind}:${fingerprint.slice(7, 19)}`;
}
export function stableEventId(type: string, projectId: string, seq: number): string {
  return `evt:${projectId}:${seq}:${type}`;
}
