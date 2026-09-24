import { digestOf } from './digest';

/** 确定性身份：由内容派生，导出/删除/再导入后保持稳定。 */
export function inputId(kind: string, payload: unknown, parentId: string | null): string {
  return 'inp_' + digestOf({ kind, payload, parentId }).slice(0, 16);
}
export function computationId(kind: string, algorithmVersion: string, paramFingerprint: string, sourceIds: string[]): string {
  return 'cmp_' + digestOf({ kind, algorithmVersion, paramFingerprint, sourceIds }).slice(0, 16);
}
export function lockId(region: unknown, candidateId: string, at: number): string {
  return 'lock_' + digestOf({ region, candidateId, at }).slice(0, 16);
}
export function eventId(seq: number, type: string, payload: unknown): string {
  return `evt_${seq}_${digestOf({ seq, type, payload }).slice(0, 8)}`;
}

/** 固定 seed 的确定性随机源（仅用于样例数据生成与测试）。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
