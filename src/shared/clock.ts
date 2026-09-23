/** 虚拟时钟：测试注入固定时间，运行时也可显式推进，保证事件顺序可重放。 */
export interface Clock {
  now(): string;
  tick(): string;
}

export function fixedClock(iso: string): Clock {
  let t = Date.parse(iso);
  return {
    now: () => new Date(t).toISOString(),
    tick: () => new Date((t += 1000)).toISOString(),
  };
}

export function systemClock(): Clock {
  return { now: () => new Date().toISOString(), tick: () => new Date().toISOString() };
}
