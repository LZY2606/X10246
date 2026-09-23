/**
 * 帧 ↔ 瓦片：共享原始片段只存一份不可变内容。
 * 瓦片固定为 blockSize x blockSize（边缘可小），缺失像素用 NaN（绝不猜值）。
 */
import type { FrameTile } from './types.ts';

export const BLOCK = 4;

export function tileKey(blockR: number, blockC: number): string {
  return `${blockR}:${blockC}`;
}

/** 把连续栅格（NaN 表示缺失）切成瓦片。 */
export function rasterToTiles(values: number[], rows: number, cols: number): FrameTile[] {
  const tiles: FrameTile[] = [];
  const br = Math.ceil(rows / BLOCK);
  const bc = Math.ceil(cols / BLOCK);
  for (let r0 = 0; r0 < br; r0++) {
    for (let c0 = 0; c0 < bc; c0++) {
      const rs = r0 * BLOCK;
      const cs = c0 * BLOCK;
      const h = Math.min(BLOCK, rows - rs);
      const w = Math.min(BLOCK, cols - cs);
      const tileValues: number[] = [];
      for (let r = rs; r < rs + h; r++) {
        for (let c = cs; c < cs + w; c++) {
          tileValues.push(values[r * cols + c]);
        }
      }
      tiles.push({ blockR: r0, blockC: c0, tileRows: h, tileCols: w, values: tileValues });
    }
  }
  return tiles;
}

/** 稀疏瓦片集 → 连续栅格；未覆盖位置为 NaN。 */
export function tilesToRaster(
  tiles: FrameTile[],
  rows: number,
  cols: number,
): Float64Array {
  const out = new Float64Array(rows * cols).fill(NaN);
  for (const t of tiles) {
    const rs = t.blockR * BLOCK;
    const cs = t.blockC * BLOCK;
    let i = 0;
    for (let r = 0; r < t.tileRows; r++) {
      for (let c = 0; c < t.tileCols; c++) {
        out[(rs + r) * cols + (cs + c)] = t.values[i++];
      }
    }
  }
  return out;
}

/** 二值遮罩（1=有效，0=无效）。 */
export function maskRaster(tiles: FrameTile[], rows: number, cols: number): Uint8Array {
  const ras = tilesToRaster(tiles, rows, cols);
  const out = new Uint8Array(rows * cols);
  for (let i = 0; i < out.length; i++) {
    const v = ras[i];
    out[i] = Number.isFinite(v) && v > 0.5 ? 1 : 0;
  }
  return out;
}

export function idx(r: number, c: number, cols: number): number {
  return r * cols + c;
}

export function inBounds(r: number, c: number, rows: number, cols: number): boolean {
  return r >= 0 && c >= 0 && r < rows && c < cols;
}

export function finiteRaster(values: Float64Array): Uint8Array {
  const out = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Number.isFinite(values[i]) ? 1 : 0;
  return out;
}
