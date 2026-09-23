/**
 * Virtual clock. Replay and tests never read the real wall clock: time
 * advances only when the clock is told to. The dev server starts the clock
 * at a fixed epoch and bumps it per operation, so reopened projects replay
 * to the same state byte-for-byte.
 */
export class VirtualClock {
  private now: number;

  constructor(start = 0) {
    this.now = start;
  }

  tick(ms = 1): number {
    this.now += ms;
    return this.now;
  }

  current(): number {
    return this.now;
  }

  set(at: number): void {
    this.now = at;
  }
}

/**
 * Deterministic PRNG (mulberry32) for any tie-breaking in algorithms.
 * Fixed seed is mandatory in tests and in the shipped case pack.
 */
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

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
}
