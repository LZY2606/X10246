import type { Grid, ResiduePayload } from '../shared/domain';
import { idx } from './grid';
import { cycleResidual } from './phase';

const RES_TOL = 1e-6;

/** 扫描全部 2x2 环，输出留数场与带电循环（循环不闭合的根因） */
export function computeResidues(wrapped: Grid, mask: Grid): ResiduePayload {
  const { width, height } = wrapped;
  const rgrid: Grid = { width, height, unit: 'rad', coordFrame: 'detector-pixel', values: new Array(width * height).fill(0) };
  const cycles = [];
  let chargedCount = 0;
  const valid = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    return mask.values[idx(mask, x, y)] !== 1 && Number.isFinite(wrapped.values[idx(mask, x, y)]);
  };
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const r = cycleResidual(wrapped, x, y, valid);
      if (r === null) continue;
      rgrid.values[idx(rgrid, x, y)] = r;
      const charged = Math.abs(r) > RES_TOL;
      if (charged) chargedCount++;
      cycles.push({
        corners: [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]] as Array<[number, number]>,
        residualRad: r,
        charged,
      });
    }
  }
  return { grid: rgrid, cycles, chargedCount };
}
