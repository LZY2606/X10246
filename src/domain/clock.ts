/** 时钟接口：测试注入虚拟时间，运行时使用系统时间。 */
export interface Clock {
  now(): string;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

export function manualClock(start = "2026-01-01T00:00:00.000Z"): Clock & {
  advance(ms: number): void;
} {
  let t = Date.parse(start);
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms;
    },
  };
}
