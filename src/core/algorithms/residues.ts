import type { PhaseGrid, ResidueCharge, ResidueMap } from "../types.ts";
import { TWO_PI, wrappedStep } from "./wrapped.ts";

// Goldstein 残差点：2x2 元胞四条边包裹梯度环绕和，
// 归一化后 +1 正残差、-1 负残差、0 无残差。

export const RESIDUE_ALGORITHM_VERSION = "residue-goldstein-1.0";

export function plaquetteKey(row: number, col: number): string {
  return `p:${row}:${col}`;
}

export function detectResidues(grid: PhaseGrid): ResidueMap {
  const { rows, cols, wrappedPhase, invalidMask } = grid;
  const charges: ResidueCharge[] = new Array((rows - 1) * (cols - 1)).fill(0);
  let positiveCount = 0;
  let negativeCount = 0;

  const idx = (r: number, c: number) => r * cols + c;

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const tl = idx(r, c);
      const tr = idx(r, c + 1);
      const br = idx(r + 1, c + 1);
      const bl = idx(r + 1, c);
      // 元胞内出现无效像素：不定义残差（孔洞边界由区域/切口处理）
      if (invalidMask[tl] || invalidMask[tr] || invalidMask[br] || invalidMask[bl]) {
        continue;
      }
      const sum =
        wrappedStep(wrappedPhase[tl], wrappedPhase[tr]) +
        wrappedStep(wrappedPhase[tr], wrappedPhase[br]) +
        wrappedStep(wrappedPhase[br], wrappedPhase[bl]) +
        wrappedStep(wrappedPhase[bl], wrappedPhase[tl]);
      const turns = Math.round(sum / TWO_PI) as ResidueCharge;
      if (turns > 0) positiveCount++;
      if (turns < 0) negativeCount++;
      charges[r * (cols - 1) + c] = turns;
    }
  }

  return {
    charges,
    positiveCount,
    negativeCount,
    algorithmVersion: RESIDUE_ALGORITHM_VERSION,
  };
}

export function listResidues(
  residueMap: ResidueMap,
  cols: number,
): Array<{ row: number; col: number; charge: ResidueCharge }> {
  const out: Array<{ row: number; col: number; charge: ResidueCharge }> = [];
  const plaquetteCols = cols - 1;
  residueMap.charges.forEach((charge, i) => {
    if (charge !== 0) {
      out.push({ row: Math.floor(i / plaquetteCols), col: i % plaquetteCols, charge });
    }
  });
  return out;
}
