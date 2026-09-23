/**
 * 导入层
 * 接受可复制的小型 JSON 样例（见 cases/ 与 README 格式说明）。
 *  - 原相位像素 / 信噪评分 / 无效遮罩 / 波长 / 入射几何 / 标定面 / 切口编辑历史
 *  - 原始表示保留在 raw_* 字段；规范化只发生在派生层
 *  - 明确的格式错误：抛 ImportError（结构化），不静默吞掉
 *  - 无法转换的值留在原位置 + diagnostics
 */
import type {
  CalibrationPlaneContent,
  CellDiagnostic,
  CutEditHistoryContent,
  IncidenceGeometryContent,
  InvalidMaskContent,
  SnrScoreContent,
  UnitScalar,
  WavelengthContent,
  WrappedPhaseContent,
  GridBasis,
  GridEdge,
} from "../shared/types.js";
import { toMeters, toRadians } from "../core/units.js";
import { wrapAngle } from "../core/grid.js";

export class ImportError extends Error {
  constructor(
    public code:
      | "not_json"
      | "missing_field"
      | "bad_shape"
      | "bad_value"
      | "ragged_grid"
      | "unsupported_kind",
    message: string,
    public path?: string,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

export interface RawSample {
  format: "fringe-ledger.sample/v1";
  name: string;
  rows: number;
  cols: number;
  /** 原相位像素：数字、"null"、或无法解析的字符串原样保留 */
  wrapped_phase: (number | string | null)[][];
  /** 振幅原始值（带单位），不要求预先归一化 */
  amplitude?: (number | string | null)[][];
  amplitude_unit?: string;
  snr?: (number | string | null)[][];
  invalid_mask?: (boolean | number | string)[][];
  wavelength: { raw: number | string; unit: string; basis?: string };
  incidence: {
    incidence_angle: { raw: number | string; unit: string };
    azimuth: { raw: number | string; unit: string };
    sensitivity_factor: { raw: number | string; unit: string };
    pixel_pitch: { raw: number | string; unit: string };
  };
  calibration: {
    a: { raw: number | string; unit: string };
    b: { raw: number | string; unit: string };
    c: { raw: number | string; unit: string };
    coordinate_basis: string;
  };
  cut_edits?: { action: "add" | "remove"; edge: { a: [number, number]; b: [number, number] }; reason: string }[];
}

export interface ParsedSample {
  name: string;
  basis: GridBasis;
  wrapped: WrappedPhaseContent;
  snr: SnrScoreContent;
  mask: InvalidMaskContent;
  wavelength: WavelengthContent;
  geometry: IncidenceGeometryContent;
  calibrationSeed: Omit<CalibrationPlaneContent, "wavelength_ref">;
  cuts: CutEditHistoryContent;
}

export function parseSampleText(text: string): RawSample {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new ImportError("not_json", `不是合法 JSON: ${(e as Error).message}`);
  }
  const s = obj as Partial<RawSample>;
  if (s === null || typeof s !== "object") throw new ImportError("not_json", "顶层必须是对象");
  if (s.format !== "fringe-ledger.sample/v1")
    throw new ImportError("unsupported_kind", `format 必须为 fringe-ledger.sample/v1，收到 ${String(s.format)}`);
  for (const f of ["name", "rows", "cols", "wrapped_phase", "wavelength", "incidence", "calibration"] as const) {
    if (s[f] === undefined) throw new ImportError("missing_field", `缺少必填字段 ${f}`, f);
  }
  const rows = Number(s.rows);
  const cols = Number(s.cols);
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 2 || cols < 2)
    throw new ImportError("bad_shape", "rows/cols 必须为 >=2 的整数");
  const wp = s.wrapped_phase!;
  if (!Array.isArray(wp) || wp.length !== rows)
    throw new ImportError("bad_shape", `wrapped_phase 需要 ${rows} 行`, "wrapped_phase");
  wp.forEach((row, r) => {
    if (!Array.isArray(row) || row.length !== cols)
      throw new ImportError("ragged_grid", `第 ${r} 行长度应为 ${cols}`, `wrapped_phase[${r}]`);
  });
  checkGridShape(s.amplitude, rows, cols, "amplitude");
  checkGridShape(s.snr, rows, cols, "snr");
  checkGridShape(s.invalid_mask, rows, cols, "invalid_mask");
  return obj as RawSample;
}

function checkGridShape(g: unknown, rows: number, cols: number, name: string): void {
  if (g === undefined) return;
  if (!Array.isArray(g) || g.length !== rows)
    throw new ImportError("bad_shape", `${name} 需要 ${rows} 行`, name);
  g.forEach((row, r) => {
    if (!Array.isArray(row) || row.length !== cols)
      throw new ImportError("ragged_grid", `${name} 第 ${r} 行长度应为 ${cols}`, `${name}[${r}]`);
  });
}

export function interpretSample(s: RawSample, pixelPitchRef?: GridBasis["pixel_pitch_ref"]): ParsedSample {
  const rows = s.rows;
  const cols = s.cols;
  const basis: GridBasis = { rows, cols, origin: "top-left", pixel_pitch_ref: pixelPitchRef };

  const wpDiag: CellDiagnostic[] = [];
  const phase = grid(rows, cols, (r, c) => {
    const raw = s.wrapped_phase[r][c];
    if (raw === null || raw === "null") return null;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (typeof raw !== "number" && Number.isNaN(n)) {
      wpDiag.push({ at: [r, c], code: "unparseable_number", message: `无法解析的相位值 ${String(raw)}`, raw });
      return null;
    }
    if (!Number.isFinite(n)) {
      wpDiag.push({ at: [r, c], code: "unparseable_number", message: `非有限相位值 ${String(raw)}`, raw });
      return null;
    }
    const w = wrapAngle(n);
    if (Math.abs(w - n) > 1e-9) {
      wpDiag.push({
        at: [r, c],
        code: "out_of_wrapped_range",
        message: `原值 ${n} 超出 (-π, π]，规范化为 ${w.toFixed(6)}，原值已保留`,
        raw,
      });
    }
    return w;
  });
  const wrapped: WrappedPhaseContent = {
    grid: phase as number[][],
    unit: "rad",
    range: "(-pi, pi]",
    basis,
    diagnostics: wpDiag,
  };

  const snrDiag: CellDiagnostic[] = [];
  const rawAmp = s.amplitude ?? grid(rows, cols, () => 1);
  const snr: (number | null)[][] = grid(rows, cols, (r, c) => {
    if (s.snr) {
      const v = s.snr[r][c];
      const n = typeof v === "number" ? v : v === null || v === "null" ? NaN : Number(v);
      if (!Number.isFinite(n)) {
        snrDiag.push({ at: [r, c], code: "unparseable_number", message: "信噪评分缺失", raw: v });
        return null;
      }
      return clamp01(n);
    }
    const a = rawAmp[r][c];
    const n = typeof a === "number" ? a : Number(a);
    return Number.isFinite(n) ? null : null; // 真正的 minmax 在派生层做
  });
  const snrContent: SnrScoreContent = {
    raw_amplitude: rawAmp as (number | string | null)[][],
    amplitude_unit: s.amplitude_unit ?? "adu",
    snr: s.snr ? snr : grid(rows, cols, () => null),
    normalization: s.snr ? "provided" : "none",
    basis,
    diagnostics: snrDiag,
  };

  const reasons: Record<string, InvalidMaskContent["reasons"][string] & { at: [number, number] }> = {};
  const invalid = grid(rows, cols, (r, c) => {
    const v = s.invalid_mask?.[r]?.[c];
    if (v === true || v === 1 || v === "1" || v === "true") {
      reasons[`${r},${c}`] = { at: [r, c], reason: "import_flag", detail: "导入遮罩标记" };
      return true;
    }
    return false;
  });
  delete (reasons as Record<string, unknown>);
  const reasonMap: Record<string, { reason: "import_flag"; detail?: string }> = {};
  for (const k of Object.keys(reasons)) {
    const { at, ...rest } = (reasons as Record<string, { at: [number, number]; reason: "import_flag"; detail?: string }>)[k];
    void at;
    reasonMap[k] = rest;
  }
  const mask: InvalidMaskContent = { invalid: invalid as boolean[][], basis, reasons: reasonMap };

  const wl = scalar(s.wavelength);
  const wlM = toMeters(wl, "wavelength.value");
  const wavelength: WavelengthContent = {
    value: wl,
    meters: wlM.value,
    diagnostics: wlM.diagnostic ? [wlM.diagnostic] : [],
  };

  const inc = s.incidence;
  const ang = toRadians(scalar(inc.incidence_angle), "incidence.incidence_angle");
  const pitch = toMeters(scalar(inc.pixel_pitch), "incidence.pixel_pitch");
  const kRaw = scalar(inc.sensitivity_factor);
  const kNum = typeof kRaw.raw === "number" ? kRaw.raw : Number(kRaw.raw);
  const geometry: IncidenceGeometryContent = {
    incidence_angle: scalar(inc.incidence_angle),
    azimuth: scalar(inc.azimuth),
    sensitivity_factor: kRaw,
    pixel_pitch: scalar(inc.pixel_pitch),
    radians: {
      incidence_angle: ang.value,
      pixel_pitch_m: pitch.value,
      k: Number.isFinite(kNum) ? kNum : null,
    },
    diagnostics: [ang.diagnostic, pitch.diagnostic].filter(Boolean) as never,
  };

  const calib = s.calibration;
  const calibrationSeed: ParsedSample["calibrationSeed"] = {
    a: scalar(calib.a),
    b: scalar(calib.b),
    c: scalar(calib.c),
    coordinate_basis: calib.coordinate_basis,
    diagnostics: [],
  };

  const cuts: CutEditHistoryContent = {
    edits: (s.cut_edits ?? []).map((e, i) => ({
      edit_id: `edit#${i}@${edgeKeyOf(e.edge)}`,
      action: e.action,
      edge: e.edge,
      reason: e.reason,
    })),
    active_cut_keys: foldCuts(s.cut_edits ?? []),
  };

  return { name: s.name, basis, wrapped, snr, mask, wavelength, geometry, calibrationSeed, cuts };
}

function edgeKeyOf(e: GridEdge): string {
  const pts = [e.a, e.b].map((p) => p.join(",")).sort();
  return pts.join("|");
}

function foldCuts(
  edits: { action: "add" | "remove"; edge: GridEdge }[],
): string[] {
  const set = new Set<string>();
  for (const e of edits) {
    const k = edgeKeyOf(e.edge);
    if (e.action === "add") set.add(k);
    else set.delete(k);
  }
  return [...set].sort();
}

function scalar(v: { raw: number | string; unit: string; basis?: string }): UnitScalar {
  return { raw: v.raw, unit: v.unit, basis: v.basis };
}

function grid<T>(rows: number, cols: number, fill: (r: number, c: number) => T): T[][] {
  const out: T[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: T[] = [];
    for (let c = 0; c < cols; c++) row.push(fill(r, c));
    out.push(row);
  }
  return out;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
