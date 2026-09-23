import type { Grid, MaskGrid, Pixel, ResidueMapPayload } from '../shared/types.ts';
import { shape, wrappedDiff } from './grid.ts';

export const RESIDUE_ALGORITHM = 'residue-field/v1';

/**
 * Itoh 残差：每个 plaquette 上包裹梯度之和 / 2π。
 * 非零残差即循环不闭合的位置；path 记录环路以便复核。
 */
export function residueField(wrapped: Grid, valid: MaskGrid): ResidueMapPayload {
  const { rows, cols } = shape(wrapped);
  const residues: (number | null)[][] = [];
  const cycles: ResidueMapPayload['cycles'] = [];
  for (let r = 0; r + 1 < rows; r++) {
    const row: (number | null)[] = [];
    for (let c = 0; c + 1 < cols; c++) {
      const corners: Pixel[] = [
        [r, c],
        [r, c + 1],
        [r + 1, c + 1],
        [r + 1, c],
      ];
      if (corners.some(([pr, pc]) => !valid[pr]?.[pc])) {
        row.push(null);
        continue;
      }
      let sum = 0;
      for (let i = 0; i < 4; i++) {
        const [ar, ac] = corners[i]!;
        const [br, bc] = corners[(i + 1) % 4]!;
        sum += wrappedDiff(wrapped[ar]![ac]!, wrapped[br]![bc]!);
      }
      const residual = Math.round(sum / (2 * Math.PI));
      row.push(residual);
      if (residual !== 0) cycles.push({ plaquette: [r, c], residual, path: corners });
    }
    residues.push(row);
  }
  return { residues, cycles };
}
