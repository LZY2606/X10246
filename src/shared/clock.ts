// 时钟抽象：生产用系统时钟，测试用虚拟时间（可快进）。
export interface Clock {
  now(): string;
}

export function systemClock(): Clock {
  return { now: () => new Date().toISOString() };
}

export function virtualClock(startIso = '2026-09-19T00:00:00.000Z'): Clock & { tick(ms: number): void } {
  let t = Date.parse(startIso);
  return {
    now: () => new Date(t).toISOString(),
    tick(ms: number) {
      t += ms;
    },
  };
}
