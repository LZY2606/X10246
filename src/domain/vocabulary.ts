/**
 * 领域词汇表：直接使用干涉测量的领域概念命名。
 * 所有领域量都携带单位或坐标基准；导入时保留原始表示，派生层才做规范化。
 */

export type PhaseUnit = 'rad' | 'cycle' | 'degree';
export type LengthUnit = 'nm' | 'um' | 'mm' | 'm';
export type AmplitudeUnit = 'adu' | 'counts' | 'V';
export type SnrUnit = 'dB' | 'linear';

/** 像素坐标系基准：原点与轴方向必须显式，跨帧对齐时使用。 */
export interface PixelBasis {
  origin: 'top-left';
  rows: number;
  cols: number;
  spacing: { dy: number; dx: number };
  spacingUnit: LengthUnit;
}

export interface AngleGeometry {
  /** 入射光相对表面法线的倾角；法向入射为 0。 */
  incidenceDeg: number;
  /** 入射面在像素坐标系中的方位角（0 = +col 方向）。 */
  azimuthDeg: number;
  rawRepresentation: string;
}

export interface WavelengthSpec {
  value: number;
  unit: LengthUnit;
  medium: string;
  rawRepresentation: string;
}

export type InputKind =
  | 'wrappedPhasePixels'
  | 'amplitudeSamples'
  | 'snrScores'
  | 'invalidMask'
  | 'wavelength'
  | 'incidenceGeometry'
  | 'calibrationSurface'
  | 'cutEditHistory';

export const INPUT_KIND_LABELS: Record<InputKind, string> = {
  wrappedPhasePixels: '包裹相位像素',
  amplitudeSamples: '振幅采样',
  snrScores: '信噪评分',
  invalidMask: '无效遮罩',
  wavelength: '波长',
  incidenceGeometry: '入射几何',
  calibrationSurface: '标定面',
  cutEditHistory: '切口编辑历史',
};

/** 网格图层：与像素坐标基准一一对应，逐格保存原值。 */
export interface Layer {
  /** 原始单位；派生层规范化单位另存，不覆盖原值。 */
  unit: string;
  /** 每行 rows*cols；无法解析的位置为 NaN 并在 diagnostics 中保留原位置。 */
  values: Float64Array;
  /** 值无法转换时保留原始字符串表示，留在原位置。 */
  rawCells?: (string | null)[];
}

export interface MaskLayer {
  /** true = 无效像素（低振幅孔洞由规则判定后进入质量图，不直接改这里）。 */
  invalid: Uint8Array;
  reason: (string | null)[];
}

export interface CalibrationSurface {
  /** 标定面高度（参考面/基准平面），单位显式。 */
  height: Layer;
  heightUnit: LengthUnit;
  shape: 'plane' | 'tilted-plane' | 'measured';
  rawRepresentation: string;
}

export interface CutEditEntry {
  editId: string;
  at: string;
  action: 'add-cut' | 'remove-cut' | 'move-cut';
  edge: { a: PixelIndex; b: PixelIndex };
  parentEditId: string | null;
  note?: string;
}

export type PixelIndex = number;

/** 一束原始网格片段（瓦片）。多个情景共享同一片段时只存一份不可变内容。 */
export interface RawTile {
  tileId: string;
  offsetRow: number;
  offsetCol: number;
  rows: number;
  cols: number;
  phase: Float64Array;
  phaseUnit: PhaseUnit;
  amplitude: Float64Array;
  amplitudeUnit: AmplitudeUnit;
  invalid: Uint8Array;
  invalidReason: (string | null)[];
}

/** 一次导入（或情景包）的完整原始契约。 */
export interface InputBundle {
  bundleId: string;
  scenarioTag: string;
  basis: PixelBasis;
  tiles: RawTile[];
  wavelength: WavelengthSpec;
  geometry: AngleGeometry;
  calibration: CalibrationSurface;
  cutHistory: CutEditEntry[];
  /** 可选：随包提供的原始信噪评分；不提供时由振幅派生（带算法版本）。 */
  snr?: { values: Float64Array; unit: SnrUnit };
  seed: number;
}

/** 导入层解析后的逐像素网格（仍然是原始值 + 原始单位，未做规范化）。 */
export interface RawGrid {
  rows: number;
  cols: number;
  phase: Float64Array;
  phaseUnit: PhaseUnit;
  amplitude: Float64Array;
  amplitudeUnit: AmplitudeUnit;
  invalid: Uint8Array;
  invalidReason: (string | null)[];
  snrProvided: Float64Array | null;
  snrUnit: SnrUnit | null;
  diagnostics: CellDiagnostic[];
  tileOrigin: Int32Array;
  bundleId: string;
}

export interface CellDiagnostic {
  index: PixelIndex;
  code: 'unparseable-value' | 'out-of-unit-range' | 'unit-conversion-rejected' | 'duplicate-tile-cell';
  rawRepresentation: string;
  detail: string;
}
