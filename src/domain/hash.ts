import { createHash } from "node:crypto";

/** 稳定内容摘要：任何实体/派生值都带 sha256 摘要，导出再导入后不变。 */
export function contentDigest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

let counter = 0;
/** 稳定身份：由命名空间 + 内容摘要 + 单调序号生成，不依赖数据库自增。 */
export function stableId(namespace: string, content: unknown, seq?: number): string {
  const n = seq ?? ++counter;
  const h = contentDigest({ namespace, content, n }).slice(0, 24);
  return `${namespace}_${h}`;
}

export function resetIdCounter(): void {
  counter = 0;
}
