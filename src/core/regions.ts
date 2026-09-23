import type { Grid } from './grid.js';
import { idx } from './grid.js';

export interface RegionResult {
  /** region id (0-based) per pixel; -1 for invalid/hole pixels. */
  regionOf: Int32Array;
  regionCount: number;
  sizes: number[];
  /** True when valid pixels split into more than one region (multi-connected). */
  multiConnected: boolean;
}

/** Connected components of valid, known pixels using 4-neighborhood. */
export function connectedRegions(
  phase: Grid,
  lowAmplitude: Uint8Array
): RegionResult {
  const { rows, cols } = phase;
  const regionOf = new Int32Array(rows * cols).fill(-1);
  const sizes: number[] = [];
  let regionCount = 0;
  for (let start = 0; start < rows * cols; start += 1) {
    if (regionOf[start] !== -1 || phase.invalid[start] || lowAmplitude[start]) continue;
    const id = regionCount;
    regionCount += 1;
    let size = 0;
    const stack = [start];
    regionOf[start] = id;
    while (stack.length) {
      const p = stack.pop()!;
      size += 1;
      const r = Math.floor(p / cols);
      const c = p % cols;
      const neighbors = [
        r > 0 ? p - cols : -1,
        r < rows - 1 ? p + cols : -1,
        c > 0 ? p - 1 : -1,
        c < cols - 1 ? p + 1 : -1
      ];
      for (const q of neighbors) {
        if (q < 0) continue;
        if (regionOf[q] !== -1 || phase.invalid[q] || lowAmplitude[q]) continue;
        regionOf[q] = id;
        stack.push(q);
      }
    }
    sizes.push(size);
  }
  return { regionOf, regionCount, sizes, multiConnected: regionCount > 1 };
}

export function regionPixelIds(result: RegionResult, regionId: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < result.regionOf.length; i += 1) {
    if (result.regionOf[i] === regionId) out.push(i);
  }
  return out;
}

export function pixelKey(index: number, cols: number): string {
  return `${Math.floor(index / cols)},${index % cols}`;
}

export function indexOfKey(r: number, c: number, cols: number): number {
  return idx(0, cols, r, c);
}
