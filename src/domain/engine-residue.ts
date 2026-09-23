import type { Grid } from './types';
import { TWO_PI, colOf, rowOf, wrap, decodeMask } from './grid';

export interface Residue { pixel: number; charge: 1 | -1 }

/**
 * 残差点：在每个四像素环路上累加主值差分。
 * 顺时针环路 p00 -> p10 -> p11 -> p01 -> p00，
 * 累加和 / 2π 即电荷（+1 正残差，-1 负残差）。
 * 环上任一像素无效则不评估（留在未知状态，而非猜 0）。
 */
export function detectResidues(phase: Grid, mask: Grid): Residue[] {
  const b = phase.coordinateBasis;
  const cells = decodeMask(mask);
  const out: Residue[] = [];
  for (let r = 0; r < b.rows - 1; r++) {
    for (let c = 0; c < b.cols - 1; c++) {
      const p00 = r * b.cols + c;
      const p10 = p00 + b.cols;
      const p11 = p10 + 1;
      const p01 = p00 + 1;
      if ([p00, p10, p11, p01].some((p) => cells[p] !== 'valid')) continue;
      const d1 = wrap(phase.values[p10] - phase.values[p00]);
      const d2 = wrap(phase.values[p11] - phase.values[p10]);
      const d3 = wrap(phase.values[p01] - phase.values[p11]);
      const d4 = wrap(phase.values[p00] - phase.values[p01]);
      const sum = d1 + d2 + d3 + d4;
      const q = Math.round(sum / TWO_PI);
      if (q === 1 || q === -1) {
        out.push({ pixel: p00, charge: q as 1 | -1 });
      } else if (q !== 0) {
        // 数值异常：保留为未知，不强行折叠
        out.push({ pixel: p00, charge: q > 0 ? 1 : -1 });
      }
    }
  }
  return out;
}

/** 供测试与文档引用：行、列号 */
export function residueLabel(phase: Grid, pixel: number): string {
  const b = phase.coordinateBasis;
  return `(${rowOf(b, pixel)},${colOf(b, pixel)})`;
}
