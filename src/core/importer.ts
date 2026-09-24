import type {
  AmplitudeFrame,
  CalibrationSurface,
  CutEditHistory,
  GridGeometry,
  IncidenceGeometry,
  InvalidMask,
  SnrScoreFrame,
  SourceContent,
  Wavelength,
  WrappedPhaseFrame,
  Dimensioned
} from "../shared/domain.ts";
import { FormatError } from "../shared/domain.ts";
import { wrap } from "./algorithm.ts";

/**
 * 导入层：接受可复制的小型样例（JSON），报告明确格式错误。
 * 原始表示保留在 rawPhase/rawText；规范化只发生在派生层。
 */

export interface SampleInput {
  grid: { rows: number; cols: number; dx: { value: number; unit: string }; dy: { value: number; unit: string }; coordinateBasis?: string };
  sourceFile?: string;
  wrappedPhase?: (number | string)[];
  amplitude?: number[];
  snr?: number[];
  invalid?: (boolean | 0 | 1)[];
  invalidReason?: string[];
  wavelength?: { value: number; unit: string; band?: string };
  geometry?: { incidenceAngle: { value: number; unit: string }; azimuth?: { value: number; unit: string } };
  calibration?: {
    normal: { x: number; y: number; z: number; basis?: string };
    offset: { value: number; unit: string };
    fitResidualRms: { value: number; unit: string };
  };
  cutEdits?: CutEditHistory["edits"];
}

function isNum(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new FormatError("not-number", `需要有限数值，得到 ${JSON.stringify(v)}`, path);
  return v;
}

function dim(v: unknown, path: string): Dimensioned {
  if (typeof v !== "object" || v === null) throw new FormatError("unit-missing", "带单位量必须是 {value,unit}", path);
  const o = v as { value?: unknown; unit?: unknown; rawText?: string };
  const value = isNum(o.value, path + ".value");
  if (typeof o.unit !== "string" || o.unit.trim() === "") throw new FormatError("unit-missing", "缺少 unit", path + ".unit");
  return { value, unit: o.unit, rawText: o.rawText ?? `${value} ${o.unit}` };
}

export function parseSample(raw: unknown, sourceFile = "pasted-sample.json"): SourceContent[] {
  if (typeof raw !== "object" || raw === null) throw new FormatError("unknown-kind", "样例必须是对象", "$");
  const s = raw as SampleInput;
  if (!s.grid || typeof s.grid.rows !== "number" || typeof s.grid.cols !== "number")
    throw new FormatError("grid-shape", "缺少 grid.rows / grid.cols", "$.grid");
  const { rows, cols } = s.grid;
  if (rows < 2 || cols < 2) throw new FormatError("grid-shape", "网格至少 2x2（需要 plaquette 才能检测残差）", "$.grid");
  const n = rows * cols;

  const basis = s.grid.coordinateBasis ?? "pixel-grid:row-down,col-right,origin=top-left";
  if (!basis) throw new FormatError("coordinate-basis-missing", "缺少坐标基准", "$.grid.coordinateBasis");
  const grid: GridGeometry = {
    rows,
    cols,
    coordinateBasis: basis,
    spacing: { dy: dim(s.grid.dy, "$.grid.dy"), dx: dim(s.grid.dx, "$.grid.dx") }
  };
  if (!grid.spacing.dy.unit || !grid.spacing.dx.unit) throw new FormatError("unit-missing", "网格间距必须带单位", "$.grid.spacing");

  const out: SourceContent[] = [];

  if (s.wrappedPhase) {
    if (s.wrappedPhase.length !== n) throw new FormatError("length-mismatch", `相位长度 ${s.wrappedPhase.length} != ${n}`, "$.wrappedPhase");
    const pixels = s.wrappedPhase.map((v, i) => {
      const rawVal = v;
      const num = typeof v === "string" ? Number(v) : v;
      if (typeof num !== "number" || !Number.isFinite(num))
        throw new FormatError("not-number", `像素 ${i} 相位不可解析: ${JSON.stringify(v)}`, `$.wrappedPhase[${i}]`);
      const w = wrap(num);
      return { phase: w, rawPhase: rawVal, diagnostic: Math.abs(w - num) > 1e-9 ? "导入值已包裹到 [-π,π]，原始表示保留在 rawPhase" : undefined };
    });
    out.push({
      kind: "WrappedPhaseFrame",
      grid,
      pixels,
      wrap: { range: "[-pi,pi)", period: { value: 2 * Math.PI, unit: "rad", rawText: "2π rad" } },
      sourceFile
    } satisfies WrappedPhaseFrame);
  }

  if (s.amplitude) {
    if (s.amplitude.length !== n) throw new FormatError("length-mismatch", `振幅长度 ${s.amplitude.length} != ${n}`, "$.amplitude");
    s.amplitude.forEach((v, i) => isNum(v, `$.amplitude[${i}]`));
    out.push({ kind: "AmplitudeFrame", grid, values: [...s.amplitude], unit: "adu", sourceFile } satisfies AmplitudeFrame);
  }

  if (s.snr) {
    if (s.snr.length !== n) throw new FormatError("length-mismatch", `信噪长度 ${s.snr.length} != ${n}`, "$.snr");
    s.snr.forEach((v, i) => isNum(v, `$.snr[${i}]`));
    out.push({ kind: "SnrScoreFrame", grid, values: s.snr.map((v) => Math.max(0, Math.min(1, v))), method: "sample-snr", sourceFile } satisfies SnrScoreFrame);
  }

  if (s.invalid) {
    if (s.invalid.length !== n) throw new FormatError("length-mismatch", `遮罩长度 ${s.invalid.length} != ${n}`, "$.invalid");
    const reason = s.invalidReason ?? [];
    out.push({
      kind: "InvalidMask",
      grid,
      invalid: s.invalid.map((v) => v === true || v === 1),
      reason: Array.from({ length: n }, (_, i) => reason[i] ?? (s.invalid![i] ? "invalid" : "valid")),
      sourceFile
    } satisfies InvalidMask);
  }

  if (s.wavelength) {
    const d = dim(s.wavelength, "$.wavelength");
    out.push({ kind: "Wavelength", wavelength: d, band: s.wavelength.band ?? "unmarked" } satisfies Wavelength);
  }
  if (s.geometry) {
    const ang = dim(s.geometry.incidenceAngle, "$.geometry.incidenceAngle");
    const azimuth = s.geometry.azimuth ? dim(s.geometry.azimuth, "$.geometry.azimuth") : undefined;
    out.push({ kind: "IncidenceGeometry", incidenceAngle: ang, azimuthAngle: azimuth } satisfies IncidenceGeometry);
  }
  if (s.calibration) {
    const offset = dim(s.calibration.offset, "$.calibration.offset");
    const rms = dim(s.calibration.fitResidualRms, "$.calibration.fitResidualRms");
    out.push({
      kind: "CalibrationSurface",
      model: {
        type: "plane",
        normal: { x: s.calibration.normal.x, y: s.calibration.normal.y, z: s.calibration.normal.z, basis: s.calibration.normal.basis ?? basis },
        offset
      },
      fitResidualRms: rms
    } satisfies CalibrationSurface);
  }
  if (s.cutEdits) {
    out.push({ kind: "CutEditHistory", edits: s.cutEdits } satisfies CutEditHistory);
  }

  if (out.length === 0) throw new FormatError("unknown-kind", "样例未包含任何可识别领域实体", "$");
  return out;
}
