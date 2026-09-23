import { createHash } from "node:crypto";
import type { ContentId, ObjectId, ObjectKind, RegionId } from "./types.js";

export function sha256Json(value: unknown): ContentId {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** 规范化 JSON（键排序），保证导出再导入后内容身份不变。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function shortHash(id: string): string {
  return id.slice(0, 12);
}

export function objectId(kind: ObjectKind, contentId: ContentId): ObjectId {
  return `obj_${kind}_${shortHash(contentId)}`;
}

export function eventSeqId(seq: number): string {
  return `evt_${String(seq).padStart(6, "0")}`;
}

export function regionId(x: number, y: number): RegionId {
  return `region_${x}_${y}`;
}

export function regionListId(xs: { x: number; y: number }[]): RegionId {
  const key = canonicalJson(xs.map((p) => [p.x, p.y]).sort());
  return `region_set_${shortHash(sha256Json(key))}`;
}

/** 参数指纹：规范化 JSON 哈希 */
export function parameterFingerprint(params: unknown): string {
  return shortHash(sha256Json(params));
}
