import { shortDigest } from "./hash.ts";

// 稳定身份：身份由“项目命名空间 + 领域键 + 内容摘要”决定，
// 导出->删除本地库->导入后仍保持；不依赖 SQLite rowid 或自增内存计数。

export function stableId(
  namespace: string,
  kind: string,
  naturalKey: string,
  content: unknown,
): string {
  return `${namespace}/${kind}/${naturalKey}/${shortDigest(content)}`;
}

/** 可重放的 mulberry32 伪随机数；所有测试与案例包使用固定 seed */
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

let counter = 0;

/** 事件 id：seq 是权威顺序，eventId 携带时间片与单调计数，保证导入后不重生 */
export function eventId(namespace: string, seq: number, atVirtual: number): string {
  counter += 1;
  return `${namespace}/evt/${String(seq).padStart(6, "0")}-${atVirtual.toString(36)}-${counter.toString(36)}`;
}

export function resetIdCounterForReplay(): void {
  counter = 0;
}
