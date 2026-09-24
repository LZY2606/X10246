// 固定 seed 的确定性伪随机数（Mulberry32），用于样例噪声与树构建破平。
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // 确定性破平：返回比较器
  jitter(scale = 1e-6): number {
    return (this.next() - 0.5) * 2 * scale;
  }
}
