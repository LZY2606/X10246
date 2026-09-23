import { createHash } from "node:crypto";
import { canonicalJSON } from "./canonical";

export function sha256Hex(data: string | Uint8Array): string {
  const h = createHash("sha256");
  h.update(data);
  return h.digest("hex");
}

export function shortHash(data: string): string {
  return sha256Hex(data).slice(0, 16);
}

/** 内容 ID：同内容永远同 ID，跨导入保持稳定。前缀标明实体类别。 */
export function contentId(prefix: string, body: unknown): string {
  return `${prefix}_${sha256Hex(canonicalJSON(body)).slice(0, 32)}`;
}

/** 参数指纹：算法版本 + 参数 + 直接来源摘要。 */
export function parameterFingerprint(body: unknown): string {
  return `fp_${sha256Hex(canonicalJSON(body)).slice(0, 20)}`;
}
