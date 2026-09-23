export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Virtual clock for deterministic tests: fixed origin, advanced explicitly. */
export class VirtualClock implements Clock {
  private t: number;
  constructor(start = 1_700_000_000_000) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): number {
    this.t += ms;
    return this.t;
  }
}
