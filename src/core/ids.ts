import { sha256Hex } from './canonical.js';

/**
 * 稳定身份发生器：同一种子+同一种类+同一序号永远得到同一 id。
 * 测试用固定 seed 得到完全确定的 id；浏览器端用项目创建时的随机种子。
 * id 一旦写入事件流就不可变，导出/导入原样保留。
 */
export interface IdGen {
  next(kind: string): string;
  peek(kind: string): string;
}

export function createIdGen(seed: string): IdGen {
  const counters = new Map<string, number>();
  const make = (kind: string, seq: number) =>
    `${kind}_${sha256Hex(`${seed}|${kind}|${seq}`).slice(0, 12)}`;
  return {
    next(kind: string): string {
      const seq = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, seq);
      return make(kind, seq);
    },
    peek(kind: string): string {
      return make(kind, (counters.get(kind) ?? 0) + 1);
    }
  };
}
