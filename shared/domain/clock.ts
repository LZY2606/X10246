/**
 * 虚拟时钟：测试与案例包重放使用固定、可控的时间。
 */
export interface Clock {
  now(): Date;
  nowIso(): string;
  advance(ms: number): void;
}

export function createClock(startIso = '2026-01-01T00:00:00.000Z', stepMs = 1): Clock {
  let t = Date.parse(startIso);
  return {
    now() {
      return new Date(t);
    },
    nowIso() {
      return new Date(t).toISOString();
    },
    advance(ms: number) {
      t += ms;
    }
  };
}

let seqCounter = 0;
export function resetIdSeq(): void {
  seqCounter = 0;
}
export function nextSeq(): number {
  return ++seqCounter;
}
