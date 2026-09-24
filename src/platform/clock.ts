export interface Clock {
  now(): number;
  random(): number;
}

/** 固定起点的虚拟时间 + 确定性 RNG：测试与案例重放不依赖主机状态 */
export function virtualClock(startMs: number, seed: number): Clock {
  let current = startMs;
  let state = seed >>> 0;
  return {
    now() {
      current += 1;
      return current;
    },
    random() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
  };
}

/** 0..2^32 范围内的确定性整数流 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
