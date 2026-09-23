/**
 * 稳定内容哈希：Node 18+ 与现代浏览器均有全局 WebCrypto。
 * 返回 hex；canonicalize 对对象键排序，使哈希与键书写顺序无关。
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [k: string]: Json };

export function canonicalize(value: Json): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortDeep(value[key]);
    }
    return out;
  }
  return value;
}

let subtleCache: SubtleCrypto | null = null;
export function getSubtle(): SubtleCrypto {
  if (subtleCache) return subtleCache;
  const candidate = (globalThis as { crypto?: Crypto }).crypto;
  if (!candidate?.subtle) throw new Error("WebCrypto subtle 不可用");
  subtleCache = candidate.subtle;
  return subtleCache;
}

export async function sha256Hex(data: string): Promise<string> {
  const buf = await getSubtle().digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class IdFactory {
  static counter = 0;
  static reset(): void {
    IdFactory.counter = 0;
  }
  /** 事件序号型稳定身份（导入/导出保持不变）。 */
  static sequential(prefix: string, seq: number): string {
    return `${prefix}_${String(seq).padStart(6, "0")}`;
  }
  /** 内容寻址身份（相同内容 -> 相同身份），带领域前缀。 */
  static async content(prefix: string, body: Json): Promise<string> {
    const hex = (await sha256Hex(canonicalize(body))).slice(0, 24);
    return `${prefix}_${hex}`;
  }
  /** 派生过程中的临时唯一编号（不入库身份，仅日志用）。 */
  static local(tag: string): string {
    IdFactory.counter += 1;
    return `tmp_${tag}_${IdFactory.counter}`;
  }
}
