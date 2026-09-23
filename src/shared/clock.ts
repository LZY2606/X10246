/** 虚拟时钟：所有事件时间戳都经由注入的 Clock 产生，测试用固定时间。 */
export type Clock = () => string;

export function fixedClock(startIso = '2026-01-05T09:00:00.000Z', stepMs = 1000): Clock {
  let t = Date.parse(startIso);
  return () => {
    const iso = new Date(t).toISOString();
    t += stepMs;
    return iso;
  };
}

export const systemClock: Clock = () => new Date().toISOString();
