import { createHash } from "node:crypto";

/** 规范化 JSON：对象键排序，保证内容寻址在导入/导出后稳定。 */
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

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 内容寻址的不可变修订身份：导出→删库→再导入后保持不变。 */
export function contentRevisionId(kind: string, content: unknown): string {
  return `${kind}:${sha256Hex(canonicalJson(content)).slice(0, 24)}`;
}

/** 派生值的稳定身份：算法、参数指纹、直接来源版本唯一确定。 */
export function derivedRevisionId(
  kind: string,
  algorithm: string,
  algorithmVersion: string,
  paramFingerprint: string,
  directSourceIds: string[],
): string {
  const basis = canonicalJson({
    k: kind,
    a: `${algorithm}@${algorithmVersion}`,
    p: paramFingerprint,
    s: [...directSourceIds].sort(),
  });
  return `${kind}:${sha256Hex(basis).slice(0, 24)}`;
}

export function fingerprintOf(params: unknown): string {
  return sha256Hex(canonicalJson(params)).slice(0, 16);
}
