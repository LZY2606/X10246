/**
 * 稳定身份：所有显示值都带身份；导出→删除本地库→导入后身份、顺序与来源关系不变。
 * 身份全部由内容/坐标确定性生成，不依赖自增主键或随机数。
 */

export function cellId(prefix: string, r: number, c: number): string {
  return `${prefix}@r${r}c${c}`;
}

export function edgeKey(a: [number, number], b: [number, number]): string {
  const [a0, a1] = a;
  const [b0, b1] = b;
  const min = a0 < b0 || (a0 === b0 && a1 < b1) ? a : b;
  const max = min === a ? b : a;
  return `${min[0]},${min[1]}|${max[0]},${max[1]}`;
}

export function plaquetteId(r: number, c: number): string {
  return `plaquette@${r},${c}`;
}

export function edgeId(edge: { a: [number, number]; b: [number, number] }): string {
  return `edge@${edgeKey(edge.a, edge.b)}`;
}

/** 实体序列 id：由提交内容的稳定前缀派生（同一导入材料同一序列）。 */
export function seriesId(kind: string, stableName: string): string {
  return `${kind}:${stableName}`;
}

export function refKey(ref: {
  kind: string;
  series_id: string;
  version: number;
}): string {
  return `${ref.kind}#${ref.series_id}@v${ref.version}`;
}

/** 固定 seed 的确定性伪随机（测试与样例生成共用，不使用 Math.random）。 */
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

/** 虚拟时钟：测试固定时间，生产环境接真实时钟。 */
export interface Clock {
  now: () => Date;
}

export function virtualClock(iso: string): Clock {
  let t = Date.parse(iso);
  return { now: () => new Date(t++) };
}

export function systemClock(): Clock {
  return { now: () => new Date() };
}
