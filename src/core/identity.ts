/**
 * 稳定身份与内容摘要：
 *  - 内容哈希使用确定性 FNV-1a 64（纯字符串，浏览器/Node 均可复现）。
 *  - 稳定 ID 形如 `wphase_Ab2f...`，同一内容不同项目复算得到同一后缀；
 *    但实体实例 ID 在提交时固定，导出/删除/再导入保持不变。
 *  - 虚拟时间（Clock）由调用方注入，测试使用固定 seed + 虚拟时间。
 */

export interface Clock {
  now(): Date;
}

export class VirtualClock implements Clock {
  private t: number;
  constructor(
    startEpochMs: number,
    private readonly stepMs = 0,
  ) {
    this.t = startEpochMs;
  }
  now(): Date {
    const d = new Date(this.t);
    this.t += this.stepMs;
    return d;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export function iso(d: Date): string {
  return d.toISOString();
}

const FNV_PRIME = 0x00000100000001b3n;
const FNV_OFFSET = 0xcbf29ce484222325n;
const MASK = 0xffffffffffffffffn;

/** 确定性 64 位 FNV-1a；对 JSON 化（键排序）后的规范文本计算。 */
export function fnv1a64(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function contentHash(value: unknown): string {
  return fnv1a64(stableStringify(value));
}

export type IdPrefix =
  | "proj"
  | "wphase"
  | "amp"
  | "snr"
  | "mask"
  | "lam"
  | "geom"
  | "cal"
  | "qual"
  | "res"
  | "cuts"
  | "tree"
  | "uph"
  | "cyc"
  | "cand"
  | "hgt"
  | "lock"
  | "evt"
  | "frag"
  | "case";

export function stableId(prefix: IdPrefix, hash: string): string {
  return `${prefix}_${hash.slice(0, 10)}`;
}

export function fingerprint(value: unknown): string {
  return contentHash(value).slice(0, 12);
}

export function idOf(prefix: IdPrefix, value: unknown): string {
  return stableId(prefix, contentHash(value));
}

export const TWO_PI = Math.PI * 2;

export function wrapToPi(x: number): number {
  let y = ((x + Math.PI) % TWO_PI) - Math.PI;
  if (y <= -Math.PI) y += TWO_PI;
  return y;
}

export function wrapTo2Pi(x: number): number {
  const y = x % TWO_PI;
  return y < 0 ? y + TWO_PI : y;
}

/** 主值差 (-π, π]，并报告该步是否跨越了包裹边界 */
export function wrappedStep(a: number, b: number): { step: number; crosses: boolean } {
  const step = wrapToPi(b - a);
  const crosses = Math.abs(step - (b - a)) > 1e-9;
  return { step, crosses };
}
