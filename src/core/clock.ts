export interface Clock {
  now(): string;
  nowMillis(): number;
}

export class VirtualClock implements Clock {
  private millis: number;
  constructor(startIso = '2026-09-01T00:00:00.000Z') {
    this.millis = Date.parse(startIso);
  }
  nowMillis(): number {
    return this.millis;
  }
  now(): string {
    return new Date(this.millis).toISOString();
  }
  advance(ms: number): string {
    this.millis += ms;
    return this.now();
  }
}

export class SystemClock implements Clock {
  nowMillis(): number {
    return Date.now();
  }
  now(): string {
    return new Date().toISOString();
  }
}
