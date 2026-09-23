export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

// 测试使用的虚拟时间：固定起点，按需推进。
export function manualClock(start = 1_700_000_000_000) {
  let t = start;
  const clock: Clock = () => t;
  clock.tick = (ms = 1000) => {
    t += ms;
    return t;
  };
  return clock as Clock & { tick: (ms?: number) => number };
}
