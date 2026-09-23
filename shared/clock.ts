/** 可注入时钟：服务器用真实时间，测试用虚拟时间。 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export function virtualClock(startMs: number, stepMs = 1000): Clock & { tick(): number } {
  let t = startMs;
  return {
    now: () => t,
    tick: () => {
      t += stepMs;
      return t;
    },
  };
}
