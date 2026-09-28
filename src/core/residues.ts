import type { GridGeometry, InvalidMaskLayer, Residue } from '../shared/model.js';
import { TWO_PI, wrap } from './wrap.js';

/**
 * 残差点（支路切口的端点）：对每个 2x2 plaquette 沿顺时针方向累加包裹梯度。
 * 理想场环路和为 0；和为 +2pi 记 +1 电荷，-2pi 记 -1。
 *
 * 触及无效遮罩或低振幅像素的 plaquette 标记 touchesBlocked：
 * 这些残差不能被常规展开路径穿越，必须配切口。
 */
export function detectResidues(
  grid: GridGeometry,
  wrapped: number[],
  blocked: boolean[],
  idFor: (at: [number, number]) => string,
): Residue[] {
  const { rows, cols } = grid;
  const idx = (r: number, c: number) => r * cols + c;
  const residues: Residue[] = [];

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const corners = [idx(r, c), idx(r, c + 1), idx(r + 1, c + 1), idx(r + 1, c)];
      if (corners.some((i) => blocked[i])) {
        // 触及阻断像素：不计算电荷，但仍可能形成边界型残差（由孔洞分量处理）
        continue;
      }
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const a = wrapped[corners[k]];
        const b = wrapped[corners[(k + 1) % 4]];
        sum += wrap(b - a);
      }
      const cycles = sum / TWO_PI;
      const rounded = Math.round(cycles);
      if (rounded === 1 || rounded === -1) {
        residues.push({
          residueId: idFor([r, c]),
          at: [r, c],
          charge: rounded as 1 | -1,
          touchesBlocked: corners.some((i) => blocked[i]),
        });
      }
    }
  }
  return residues;
}
