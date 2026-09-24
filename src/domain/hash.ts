/**
 * 确定性内容寻址。
 * 不依赖 Node crypto / WebCrypto，保证固定 seed、可跨浏览器与离线重放。
 */
export function fnv1a32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

export function digestOf(value: unknown): string {
  return "sha256:" + fnv1a32(stableStringify(value)).padStart(8, "0") + "-" +
    fnv1a32(stableStringify(value) + ":salt-b").toString(16).padStart(8, "0");
}

export function shortId(prefix: string, content: unknown): string {
  return `${prefix}_${fnv1a32(prefix + "|" + stableStringify(content)).slice(0, 10)}`;
}
