export interface Clock {
  now(): string;
}

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

/** 虚拟时钟：测试专用，每次调用前进固定步长，保证可复现。 */
export class VirtualClock implements Clock {
  private tick: number;
  constructor(start = '2026-01-01T00:00:00.000Z', private stepMs = 1000) {
    this.tick = Date.parse(start);
  }
  now(): string {
    const stamp = new Date(this.tick).toISOString();
    this.tick += this.stepMs;
    return stamp;
  }
}
