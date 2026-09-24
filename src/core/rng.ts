/** 固定 seed 的确定性 PRNG（mulberry32），测试与重放不依赖 Math.random。 */
export function createRng(seedHex: string): () => number {
  let a = parseInt(seedHex.slice(0, 8), 16) >>> 0;
  if (a === 0) a = 0x9e3779b9;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 虚拟时钟：测试中显式推进；生产环境接真实时间。 */
export interface Clock {
  now(): string;
  tick(ms: number): void;
}
export function createClock(startIso: string): Clock {
  let t = Date.parse(startIso);
  return {
    now: () => new Date(t).toISOString(),
    tick: (ms: number) => {
      t += ms;
    }
  };
}

/** 参数指纹：规范化排序后的参数串。 */
export function parameterFingerprint(params: Record<string, unknown>): string {
  const keys = Object.keys(params).sort();
  return keys.map((k) => `${k}=${JSON.stringify(params[k])}`).join("|");
}
