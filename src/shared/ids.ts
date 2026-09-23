import { createHash } from "node:crypto";

/**
 * 规范化 JSON：键排序，保证同样内容在导出/删除/导入后得到相同摘要。
 * 不可变内容只用它算指纹；事件顺序另由 seq 保持。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJson(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .filter((k) => obj[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]))
      .join(",") +
    "}"
  );
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${contentHash(value).slice(0, 16)}`;
}

/** 派生记录的可读短标签（前缀+序号），序号在项目内稳定，重放一致。 */
export function ordinalId(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(4, "0")}`;
}

/** 固定 seed 的确定性伪随机（mulberry32），用于候选次序等。 */
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
