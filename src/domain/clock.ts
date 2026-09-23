/** 可注入的虚拟时钟：测试使用固定虚拟时间，默认走真实时间 */
export interface Clock {
  now(): Date;
  nowIso(): string;
  advance(ms: number): void;
}

export function createClock(startIso = '2026-01-01T00:00:00.000Z'): Clock {
  let current = Date.parse(startIso);
  return {
    now: () => new Date(current),
    nowIso: () => new Date(current).toISOString(),
    advance: (ms: number) => {
      current += ms;
    },
  };
}
