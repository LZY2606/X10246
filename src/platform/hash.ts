import { createHash } from "node:crypto";

/** 规范化 JSON（对象键排序），保证哈希跨进程稳定 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function digestPrefix(value: unknown, length = 14): string {
  return sha256Hex(value).slice(0, length);
}
