// 虚拟时间：默认从固定纪元起步，按 tick 推进；测试可完全确定，不读系统时钟。

export class VirtualClock {
  private now: number;

  constructor(start = 1_700_000_000_000, private readonly stepMs = 1000) {
    this.now = start;
  }

  tick(ms?: number): number {
    this.now += ms ?? this.stepMs;
    return this.now;
  }

  current(): number {
    return this.now;
  }
}
