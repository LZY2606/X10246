import { idx, wrappedDiff } from './grid';
import type {
  InvalidMaskFrame,
  ResidueMap,
  ResidueInfo,
  WrappedPhaseFrame,
} from '../domain/types';

export const RESIDUE_ALGO_VERSION = 'residue/v1';

/**
 * 小面元（plaquette）旋度：对 (i,j),(i+1,j),(i+1,j+1),(i,j+1) 求包裹差之和，
 * 归一化到 2*pi 得到电荷 -1 / 0 / +1（Itoh 残差点）。
 * 任何一个顶点无效则该小面元不参与判定，记 null，绝不跨孔洞闭合。
 */
export function buildResidueMap(
  phase: WrappedPhaseFrame,
  mask: InvalidMaskFrame
): ResidueMap {
  const g = phase.grid;
  const charges: (-1 | 0 | 1 | null)[] = [];
  const residues: ResidueInfo[] = [];
  let n = 0;
  for (let j = 0; j < g.height - 1; j++) {
    for (let i = 0; i < g.width - 1; i++) {
      const p00 = idx(g, i, j);
      const p10 = idx(g, i + 1, j);
      const p11 = idx(g, i + 1, j + 1);
      const p01 = idx(g, i, j + 1);
      if (
        phase.phase[p00] === null ||
        phase.phase[p10] === null ||
        phase.phase[p11] === null ||
        phase.phase[p01] === null ||
        mask.invalid[p00] ||
        mask.invalid[p10] ||
        mask.invalid[p11] ||
        mask.invalid[p01]
      ) {
        charges.push(null);
        n++;
        continue;
      }
      const phi00 = phase.phase[p00] as number;
      const phi10 = phase.phase[p10] as number;
      const phi11 = phase.phase[p11] as number;
      const phi01 = phase.phase[p01] as number;
      const wrap =
        wrappedDiff(phi00, phi10) +
        wrappedDiff(phi10, phi11) +
        wrappedDiff(phi11, phi01) +
        wrappedDiff(phi01, phi00);
      const q = Math.round(wrap / (2 * Math.PI)) as -1 | 0 | 1;
      charges.push(q);
      if (q !== 0) {
        residues.push({ i, j, plaquette: n, charge: q });
      }
      n++;
    }
  }
  return { grid: g, charges, residues };
}
