// 虚拟时钟：所有时间从可注入时钟获得，测试固定 seed + 虚拟时间。
export interface Clock {
  nowISO(): string;
  nowMs(): number;
  tick(ms: number): void;
}

export function createVirtualClock(startISO = "2026-01-01T00:00:00.000Z"): Clock {
  let t = Date.parse(startISO);
  return {
    nowISO: () => new Date(t).toISOString(),
    nowMs: () => t,
    tick: (ms: number) => {
      t += ms;
    },
  };
}

export function createSystemClock(): Clock {
  return {
    nowISO: () => new Date().toISOString(),
    nowMs: () => Date.now(),
    tick: () => undefined,
  };
}
