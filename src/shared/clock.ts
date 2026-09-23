/** 虚拟时钟：服务层只依赖该接口，测试注入固定时间，服务器用真实时间。 */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

/** 从固定起点步进的虚拟时钟（测试用）。 */
export function fixedClock(startMs = 1_700_000_000_000, stepMs = 1000): Clock {
  let t = startMs;
  return () => {
    const now = t;
    t += stepMs;
    return now;
  };
}
