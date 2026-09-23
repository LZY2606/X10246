import type {
  CalibrationPlaneData, Diagnostic, HeightMapPayload, IncidenceGeometryData,
  UnwrapCandidatePayload, WavelengthData, GridData,
} from '../shared/types';
import { TWO_PI } from './unwrap';

/** 波长规范化：保留原始表示，派生层统一转 nm；无法转换则附诊断。 */
export function normalizeWavelength(w: WavelengthData): { nm: number | null; diagnostics: Diagnostic[] } {
  const factor = w.unit === 'nm' ? 1 : w.unit === 'um' ? 1000 : w.unit === 'pm' ? 0.001 : null;
  if (factor === null || !Number.isFinite(w.value)) {
    return {
      nm: null,
      diagnostics: [{
        code: 'UNIT_UNCONVERTIBLE',
        message: `波长单位不可转换：${w.raw}（保留原始表示，不参与派生计算）`,
      }],
    };
  }
  return { nm: w.value * factor, diagnostics: [] };
}

/** 入射角规范化：deg -> rad。 */
export function normalizeIncidence(g: IncidenceGeometryData): { thetaRad: number | null; diagnostics: Diagnostic[] } {
  if (!Number.isFinite(g.thetaDeg) || g.thetaDeg < 0 || g.thetaDeg >= 90) {
    return {
      thetaRad: null,
      diagnostics: [{ code: 'UNIT_UNCONVERTIBLE', message: `入射角不可转换：${g.raw}` }],
    };
  }
  return { thetaRad: (g.thetaDeg * Math.PI) / 180, diagnostics: [] };
}

/**
 * 高度转换链：包裹相位 + 整周场 -> 展开相位 -> 光程 -> 高度 -> 减标定面。
 * 反射式：height = (φ/2π) * λ / (2 cos θ) - plane(x,y)。
 * 未知整周的像素保持 null 并附诊断，不能为了画图丢掉。
 */
export function computeHeightMap(
  wrapped: GridData,
  candidate: UnwrapCandidatePayload,
  wavelength: WavelengthData,
  geometry: IncidenceGeometryData,
  plane: CalibrationPlaneData,
): HeightMapPayload {
  const { width: w, height: h } = wrapped;
  const wl = normalizeWavelength(wavelength);
  const geo = normalizeIncidence(geometry);
  const diagnostics: Diagnostic[] = [...wl.diagnostics, ...geo.diagnostics];
  const convertible = wl.nm !== null && geo.thetaRad !== null;

  const chain: HeightMapPayload['chain'] = [
    { step: 'phase_to_cycles', detail: 'φ_unwrapped = wrapped + 2πk（低振幅区域 k 未知，不猜相位）', params: { algorithm: 'branch-cut-unwrap' } },
    { step: 'cycles_to_opd', detail: 'opd = cycles * λ', params: { wavelength_nm: wl.nm, raw: wavelength.raw } },
    { step: 'opd_to_height', detail: 'height = opd / (2 cos θ)（反射式）', params: { theta_deg: geometry.thetaDeg, basis: geometry.basis } },
    { step: 'subtract_calibration_plane', detail: 'z = height - (a*x + b*y + c)', params: { a: plane.a, b: plane.b, c: plane.c, unit: plane.unit, basis: plane.basis } },
  ];

  const heights: Array<number | null> = new Array(w * h).fill(null);
  const unknownPixels: number[] = [];
  if (convertible) {
    const cosTheta = Math.cos(geo.thetaRad!);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const i = r * w + c;
        const k = candidate.kField[i];
        if (k === null) { unknownPixels.push(i); continue; }
        const unwrapped = wrapped.values[i] + TWO_PI * k;
        const cycles = unwrapped / TWO_PI;
        const heightNm = (cycles * wl.nm!) / (2 * cosTheta);
        heights[i] = heightNm - (plane.a * c + plane.b * r + plane.c);
      }
    }
  } else {
    for (let i = 0; i < w * h; i++) if (candidate.kField[i] !== null) unknownPixels.push(i);
  }
  if (unknownPixels.length > 0) {
    diagnostics.push({
      code: convertible ? 'LOW_AMPLITUDE_HOLE' : 'UNIT_UNCONVERTIBLE',
      message: convertible
        ? `${unknownPixels.length} 像素整周未知：高度留空并保留在原位置`
        : `单位不可转换：${unknownPixels.length} 像素高度保持未知，原始相位保留`,
      pixels: unknownPixels,
    });
  }
  return { width: w, height: h, unit: 'nm', basis: wrapped.coordBasis, heights, chain, diagnostics };
}
