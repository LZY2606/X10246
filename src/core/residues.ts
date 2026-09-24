import { idx } from './grid.js';
import { provenance, ALGORITHM_VERSIONS } from './provenance.js';
import { wrapPi } from './units.js';
import type {
  InvalidMask,
  Residue,
  ResidueMap,
  VersionRef,
  WrappedPhasePixels,
} from './types.js';

export const RESIDUE_PARAMS = { tolerance: 1e-6 } as const;

/**
 * 残差点检测：对每个 2×2 像素环计算
 *   Δ = wrap(φ12)+wrap(φ23)+wrap(φ34)+wrap(φ41)
 * 理想为 0；+2π 正残差 / -2π 负残差。
 * 任一像素无效则该环不参与（不猜测被遮罩像素）。
 */
export function detectResidues(
  phaseRad: number[],
  mask: InvalidMask,
  phaseMeta: WrappedPhasePixels,
  sources: VersionRef[],
): ResidueMap {
  const { rows, cols } = phaseMeta.basis;
  const residues: Residue[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const p00 = idx(phaseMeta.basis, r, c);
      const p01 = idx(phaseMeta.basis, r, c + 1);
      const p11 = idx(phaseMeta.basis, r + 1, c + 1);
      const p10 = idx(phaseMeta.basis, r + 1, c);
      if ([p00, p01, p11, p10].some((p) => mask.values[p])) continue;
      const d01 = wrapPi(phaseRad[p01] - phaseRad[p00]);
      const d12 = wrapPi(phaseRad[p11] - phaseRad[p01]);
      const d23 = wrapPi(phaseRad[p10] - phaseRad[p11]);
      const d30 = wrapPi(phaseRad[p00] - phaseRad[p10]);
      const loop = d01 + d12 + d23 + d30;
      const winding = Math.round(loop / (2 * Math.PI));
      if (Math.abs(loop - winding * 2 * Math.PI) > 1e-3 && Math.abs(loop) > 1e-3) {
        residues.push({
          r,
          c,
          charge: loop > 0 ? 1 : -1,
          loopSum2pi: loop / (2 * Math.PI),
        });
      }
    }
  }
  return {
    kind: 'residueMap',
    basis: phaseMeta.basis,
    residues,
    algorithm: provenance('detectResidues', ALGORITHM_VERSIONS.residues, { ...RESIDUE_PARAMS }),
    sources,
  };
}
