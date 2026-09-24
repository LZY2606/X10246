// 虚拟时钟 + 固定 seed RNG：测试可重放，不依赖墙钟与机器随机性
export class VirtualClock {
  private counter: number;
  constructor(start = 1_700_000_000_000) {
    this.counter = start;
  }
  now(): number {
    this.counter += 1;
    return this.counter;
  }
  seedValue(): number {
    return this.counter;
  }
  set(v: number): void {
    this.counter = v;
  }
}

export class SeededRng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    // xorshift32 —— 固定 seed 下完全确定
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0xffffffff;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
}
