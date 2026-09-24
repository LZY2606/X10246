/** 时钟抽象：测试使用虚拟时间，开发使用系统时间 */
export interface Clock {
  now(): string;
}
export class SystemClock implements Clock {
  now(): string { return new Date().toISOString(); }
}
export class VirtualClock implements Clock {
  private t: number;
  constructor(startIso = '2026-09-24T00:00:00.000Z', private stepMs = 1000) {
    this.t = Date.parse(startIso);
  }
  now(): string {
    const iso = new Date(this.t).toISOString();
    this.t += this.stepMs;
    return iso;
  }
  advance(ms: number): void { this.t += ms; }
}
