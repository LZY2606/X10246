/**
 * 虚拟时钟：默认从固定纪元开始，可手动推进，保证所有审计事件时间戳确定且可重放。
 */
export class VirtualClock {
  private nowMs: number;
  constructor(epochIso = "2026-01-01T00:00:00+09:00") {
    this.nowMs = Date.parse(epochIso);
  }
  now(): string {
    return new Date(this.nowMs).toISOString();
  }
  advance(ms: number): string {
    this.nowMs += ms;
    return this.now();
  }
  set(iso: string): string {
    this.nowMs = Date.parse(iso);
    return this.now();
  }
}

export type Clock = { now(): string };
