import { TWO_PI, wrap } from './wrap.js';
import { FRAME_PIXEL } from '../shared/units.js';
import type {
  AmplitudeLayer,
  CalibrationPlane,
  IncidenceGeometry,
  InvalidMaskLayer,
  RawSourceBundle,
  SnrScoreLayer,
  WrappedPhaseLayer,
  WavelengthSpec,
} from '../shared/model.js';

export const CASE_ROWS = 16;
export const CASE_COLS = 16;

export interface FieldLayers {
  phase: number[]; // 连续相位（弧度），包裹由下游做
  amplitude: number[];
  mask: boolean[];
  snr: number[];
}

const idx = (r: number, c: number, cols = CASE_COLS) => r * cols + c;

/** 平滑倾斜平面（线性相位），并可叠加竖直条纹 */
export function smoothTilt(rows: number, cols: number, slope: number): number[] {
  const out = new Array<number>(rows * cols);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) out[idx(r, c, cols)] = slope * c;
  return out;
}

/**
 * 涡旋相位 arg(z - center)：在 center 的 plaquette 产生 +1 残差。
 * 符号 sign=-1 产生 -1 残差。
 */
export function vortex(
  rows: number,
  cols: number,
  center: [number, number],
  sign: 1 | -1,
): number[] {
  const out = new Array<number>(rows * cols);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      out[idx(r, c, cols)] = sign * Math.atan2(r - center[0], c - center[1]);
    }
  return out;
}

/** 涡旋偶极子：+1 与 -1 配对，它们之间天然存在一条相位缝（支路切口）。 */
export function vortexDipole(
  rows: number,
  cols: number,
  plus: [number, number],
  minus: [number, number],
  slope = 0.15,
): number[] {
  const a = vortex(rows, cols, plus, 1);
  const b = vortex(rows, cols, minus, -1);
  const tilt = smoothTilt(rows, cols, slope);
  const out = new Array<number>(rows * cols);
  for (let i = 0; i < out.length; i++) out[i] = wrap(a[i] + b[i] + tilt[i]);
  return out;
}

export function constantField(value: number, n: number): number[] {
  return new Array(n).fill(value);
}

/** 在一个矩形区域打“孔洞”：遮罩或低振幅 */
export function stampRegion(
  mask: boolean[],
  amplitude: number[],
  snr: number[],
  rect: { r0: number; c0: number; r1: number; c1: number },
  mode: 'mask' | 'low-amp',
  cols = CASE_COLS,
): void {
  for (let r = rect.r0; r <= rect.r1; r++)
    for (let c = rect.c0; c <= rect.c1; c++) {
      const i = idx(r, c, cols);
      if (mode === 'mask') {
        mask[i] = true;
        amplitude[i] = 0;
        snr[i] = 0;
      } else {
        amplitude[i] = 0.05; // 低于 amplitudeFloor=0.2
        snr[i] = 0.05;
      }
    }
}

export interface BuildBundleInput {
  sourceId: string;
  parentSourceId?: string | null;
  label: string;
  rows?: number;
  cols?: number;
  phase: number[];
  amplitude?: number[];
  mask?: boolean[];
  snr?: number[];
  wavelength?: Partial<WavelengthSpec> & { wavelengthId: string };
  geometry?: Partial<IncidenceGeometry> & { geometryId: string };
  calibration?: Partial<CalibrationPlane> & { calibrationId: string };
  createdAtVirtual: number;
}

export function buildBundle(input: BuildBundleInput): RawSourceBundle {
  const rows = input.rows ?? CASE_ROWS;
  const cols = input.cols ?? CASE_COLS;
  const n = rows * cols;
  const phase = input.phase;
  const amplitude = input.amplitude ?? constantField(1, n);
  const mask = input.mask ?? new Array(n).fill(false);
  const snr = input.snr ?? constantField(0.95, n);

  const wavelength: WavelengthSpec = {
    wavelengthId: input.wavelength?.wavelengthId ?? 'wl-v1',
    parentId: input.wavelength?.parentId ?? null,
    value: input.wavelength?.value ?? 632.8,
    unit: input.wavelength?.unit ?? 'nm',
    refractiveIndex: input.wavelength?.refractiveIndex ?? 1.0003,
    revisionNote: input.wavelength?.revisionNote ?? 'He-Ne 632.8nm 初始波长',
  };
  const geometry: IncidenceGeometry = {
    geometryId: input.geometry?.geometryId ?? 'geo-normal',
    incidenceAngle: input.geometry?.incidenceAngle ?? 0,
    angleUnit: input.geometry?.angleUnit ?? 'deg',
    model: input.geometry?.model ?? 'normal-incidence',
    sensitivityFactorMetersPerRad: input.geometry?.sensitivityFactorMetersPerRad,
  };
  const calibration: CalibrationPlane = {
    calibrationId: input.calibration?.calibrationId ?? 'cal-v1',
    parentId: input.calibration?.parentId ?? null,
    pixelScaleMeters: input.calibration?.pixelScaleMeters ?? 1e-5,
    referenceHeightM: input.calibration?.referenceHeightM ?? 0,
    fitResidualM: input.calibration?.fitResidualM ?? 3.2e-9,
    note: input.calibration?.note ?? '初始平面标定',
  };

  const wrappedLayer: WrappedPhaseLayer = {
    kind: 'wrapped-phase',
    values: phase.map((p) => wrap(p)),
    unit: 'rad',
    declaredRange: [-Math.PI, Math.PI],
  };
  const ampLayer: AmplitudeLayer = { kind: 'amplitude', values: amplitude, unit: 'adu' };
  const maskLayer: InvalidMaskLayer = { kind: 'invalid-mask', values: mask };
  const snrLayer: SnrScoreLayer = { kind: 'snr-score', values: snr, unit: 'ratio' };

  return {
    sourceId: input.sourceId,
    parentSourceId: input.parentSourceId ?? null,
    label: input.label,
    grid: { rows, cols, frame: FRAME_PIXEL },
    wrappedPhase: wrappedLayer,
    amplitude: ampLayer,
    invalidMask: maskLayer,
    snr: snrLayer,
    wavelength,
    geometry,
    calibration,
    cutHistory: [],
    createdAtVirtual: input.createdAtVirtual,
  };
}

export { TWO_PI };
