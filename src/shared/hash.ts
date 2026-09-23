import { createHash } from "node:crypto";

export function sha256Hex(obj: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(obj))
    .digest("hex");
}

export function shortHash(obj: unknown): string {
  return sha256Hex(obj).slice(0, 12);
}

/** 确定性 JSON：键排序、无空白——保证哈希与顺序跨进程一致。 */
export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((obj as Record<string, unknown>)[k])}`).join(",")}}`;
}
