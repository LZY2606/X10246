import type {
  Diagnostic,
  Grid,
  HeightMapPayload,
  Ref,
  UnwrapCandidatePayload,
} from '../shared/types.ts';
import { shape } from './grid.ts';

export const HEIGHT_ALGORITHM = 'height-conversion/v1';

export interface HeightInputs {
  candidate: UnwrapCandidatePayload;
  candidateRef: Ref;
  wavelengthNm: number;
  wavelengthRef: Ref;
  cosIncidence: number;
  cosReflection: number;
  geometryRef: Ref;
  plane: [number, number, number];
  planeRef: Ref;
  basis: string;
}

export interface HeightResult {
  payload: HeightMapPayload | null;
  diagnostics: Diagnostic[];
}

/**
 * 高度转换链：h = (φ - plane) · λ / (2π (cosθi + cosθr))。
 * 每一级都记录显式版本引用；未知像素保持未知。
 */
export function heightMap(input: HeightInputs): HeightResult {
  const { rows, cols } = shape(input.candidate.phase as Grid);
  const factor = input.wavelengthNm / (2 * Math.PI * (input.cosIncidence + input.cosReflection));
  const height: (number | null)[][] = [];
  const [c0, cr, cc] = input.plane;
  for (let r = 0; r < rows; r++) {
    const row: (number | null)[] = [];
    for (let c = 0; c < cols; c++) {
      const phi = input.candidate.phase[r]![c];
      if (phi === null || phi === undefined) {
        row.push(null);
        continue;
      }
      const planeLevel = c0 + cr * r + cc * c;
      row.push((phi - planeLevel) * factor);
    }
    height.push(row);
  }
  return {
    payload: {
      candidateId: input.candidateRef.id,
      height,
      heightUnit: 'nm',
      basis: input.basis,
      chain: [
        { stage: 'wavelength', ref: input.wavelengthRef },
        { stage: 'incidence_geometry', ref: input.geometryRef },
        { stage: 'calibration_plane', ref: input.planeRef },
        { stage: 'unwrap_candidate', ref: input.candidateRef },
      ],
    },
    diagnostics: [],
  };
}
