/** 确定性随机源（固定 seed，可重放） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type IdGen = (prefix: string) => string;

/** 稳定身份生成器：seed 固定时可完整重放同一串 id */
export function createIdGen(seed: number): IdGen {
  const rng = mulberry32(seed);
  let counter = 0;
  return (prefix: string) =>
    `${prefix}_${(counter++).toString(36).padStart(4, '0')}${Math.floor(rng() * 1e9).toString(36)}`;
}
