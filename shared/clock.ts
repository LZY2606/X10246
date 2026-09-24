/** 虚拟时钟：所有时间戳来自它，测试可注入固定值。 */
export interface Clock { now(): number; }

export class VirtualClock implements Clock {
  private t: number;
  constructor(start = 1_700_000_000_000) { this.t = start; }
  now(): number { return ++this.t; }
  set(t: number): void { this.t = Math.max(this.t, t); }
}
