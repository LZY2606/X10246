/** 可注入时钟：测试使用虚拟时间，运行时使用真实时间。 */
export interface Clock { now(): string; }
export const systemClock: Clock = { now: () => new Date().toISOString() };
export function virtualClock(start = '2026-01-01T00:00:00.000Z', stepMs = 1000): Clock & { tick(): void } {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t).toISOString(),
    tick: () => { t += stepMs; },
  };
}
