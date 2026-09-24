import { createHash } from "node:crypto";

/** 规范化 JSON（键排序），保证跨机器/跨导入摘要一致。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function shortDigest(value: unknown): string {
  return sha256(value).slice(0, 12);
}

/** 内容寻址的不可变片段 id：相同内容 => 相同 id（共享片段只存一份）。 */
export function fragmentId(kind: string, content: unknown): string {
  return `frag_${kind}_${sha256({ kind, content }).slice(0, 16)}`;
}

/** 实体稳定身份：由逻辑流（lineage）决定，跨导出/导入保持。 */
export function lineageId(kind: string, key: string): string {
  return `line_${kind}_${sha256({ kind, key }).slice(0, 16)}`;
}

/** 实体版本实例 id：身份 + 版本 + 内容，导出再导入保持完全一致。 */
export function entityVersionId(lineage: string, version: number, digest: string): string {
  return `${lineage}__v${version}__${digest.slice(0, 10)}`;
}

export function eventId(seq: number, hash: string): string {
  return `evt-${seq}-${hash.slice(0, 7)}`;
}

/** 固定 seed 的可复现 PRNG（mulberry32），测试与样例生成共用。 */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
