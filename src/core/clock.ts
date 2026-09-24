/** 虚拟时钟：测试与重放可固定时间，绝不依赖机器本地时间产生身份。 */
export class VirtualClock {
  private nowIso: string;
  constructor(startIso = "2026-01-01T00:00:00.000Z") {
    this.nowIso = startIso;
  }
  now(): string {
    return this.nowIso;
  }
  advance(ms: number): string {
    const t = Date.parse(this.nowIso) + ms;
    this.nowIso = new Date(t).toISOString();
    return this.nowIso;
  }
  set(iso: string): string {
    this.nowIso = iso;
    return this.nowIso;
  }
}
