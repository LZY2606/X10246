import type {
  AmplitudePayload,
  CalibrationPlanePayload,
  CutEditHistoryPayload,
  IncidenceGeometryPayload,
  ImportDiagnostic,
  InputPayload,
  InvalidMaskPayload,
  RawRepresentation,
  SnrScorePayload,
  WavelengthPayload,
  WrappedPhasePayload,
} from "../../shared/types.js";

export class ImportFormatError extends Error {
  constructor(
    public code:
      | "DIMENSION_MISMATCH"
      | "MISSING_FIELD"
      | "BAD_ENCODING"
      | "BAD_UNIT"
      | "BAD_RANGE"
      | "BAD_GEOMETRY",
    message: string,
    public at?: { x: number; y: number },
  ) {
    super(message);
    this.name = "ImportFormatError";
  }
}

export type RawImportRequest =
  | { kind: "wrapped_phase"; channel?: string; width: number; height: number;
      encoding: "float_rad_pmpi" | "float_rad_0_2pi" | "uint8_0_2pi" | "uint16_0_2pi";
      values: number[]; wrapRange?: "[-pi,pi)" | "[0,2pi)" }
  | { kind: "amplitude"; channel?: string; width: number; height: number;
      encoding: "float" | "uint8" | "uint16"; values: number[]; amplitudeUnit?: string }
  | { kind: "snr_score"; channel?: string; width: number; height: number;
      encoding: "float_dimensionless" | "float_dB" | "uint8_pct"; values: number[]; threshold?: number }
  | { kind: "invalid_mask"; width: number; height: number; values: (0 | 1 | boolean)[]; reason?: string }
  | { kind: "wavelength"; channel?: string; value: number; unit: "nm" | "um"; effective?: { value: number; unit: "nm" | "um" } }
  | { kind: "incidence_geometry"; arrangement: IncidenceGeometryPayload["arrangement"];
      incidenceAngleDeg?: number; passFactor?: number; sensitivityVectorNote?: string }
  | { kind: "calibration_plane"; lengthUnit?: string;
      anchors: { x: number; y: number; physical: { x: number; y: number; z: number } }[] }
  | { kind: "cut_edit_history"; note?: string; edits: CutEditHistoryPayload["edits"] };

function checkDims(req: { width: number; height: number; values: unknown[] }) {
  if (!Number.isInteger(req.width) || !Number.isInteger(req.height) || req.width <= 0 || req.height <= 0)
    throw new ImportFormatError("MISSING_FIELD", "width/height 必须为正整数");
  if (req.values.length !== req.width * req.height)
    throw new ImportFormatError(
      "DIMENSION_MISMATCH",
      `数据长度 ${req.values.length} != ${req.width}*${req.height}=${req.width * req.height}`,
    );
}

function normalizeGrid(
  req: { width: number; height: number; values: number[] },
  convert: (v: number, x: number, y: number, diags: ImportDiagnostic[]) => number | null,
): { values: (number | null)[]; diags: ImportDiagnostic[] } {
  const diags: ImportDiagnostic[] = [];
  const values = req.values.map((v, i) => {
    const x = i % req.width;
    const y = Math.floor(i / req.width);
    return convert(v, x, y, diags);
  });
  return { values, diags };
}

function wrapToPmpi(v: number): number {
  let w = v % (Math.PI * 2);
  if (w >= Math.PI) w -= Math.PI * 2;
  if (w < -Math.PI) w += Math.PI * 2;
  return w;
}
function wrapTo02pi(v: number): number {
  const w = v % (Math.PI * 2);
  return w < 0 ? w + Math.PI * 2 : w;
}

const RAW_ENCODING_LABEL: Record<string, string> = {
  float_rad_pmpi: "float64 rad [-pi,pi)",
  float_rad_0_2pi: "float64 rad [0,2pi)",
  uint8_0_2pi: "uint8 scaled [0,2pi)",
  uint16_0_2pi: "uint16 scaled [0,2pi)",
};

export function importInput(req: RawImportRequest): { payload: InputPayload; diagnostics: ImportDiagnostic[] } {
  switch (req.kind) {
    case "wrapped_phase": {
      checkDims(req);
      const diags: ImportDiagnostic[] = [];
      const raw: RawRepresentation = { encoding: req.encoding, values: req.values.slice() };
      let normalized: (number | null)[];
      const wrapRange = req.wrapRange ?? (req.encoding === "float_rad_pmpi" ? "[-pi,pi)" : "[0,2pi)");
      if (req.encoding === "float_rad_pmpi" || req.encoding === "float_rad_0_2pi") {
        normalized = normalizeGrid(req, (v, x, y, d) => {
          if (!Number.isFinite(v)) {
            d.push({ code: "UNCONVERTIBLE_VALUE_LEFT_IN_PLACE", at: { x, y }, message: "非有限相位值保留为未知", rawValue: v });
            return null;
          }
          return wrapRange === "[-pi,pi)" ? wrapToPmpi(v) : wrapTo02pi(v);
        }).values;
      } else if (req.encoding === "uint8_0_2pi") {
        normalized = normalizeGrid(req, (v, x, y, d) => {
          if (!Number.isInteger(v) || v < 0 || v > 255) {
            d.push({ code: "UNCONVERTIBLE_VALUE_LEFT_IN_PLACE", at: { x, y }, message: "越界 uint8 相位值保留原位", rawValue: v });
            return null;
          }
          return wrapTo02pi((v / 255) * Math.PI * 2);
        }).values;
      } else {
        normalized = normalizeGrid(req, (v, x, y, d) => {
          if (!Number.isInteger(v) || v < 0 || v > 65535) {
            d.push({ code: "UNCONVERTIBLE_VALUE_LEFT_IN_PLACE", at: { x, y }, message: "越界 uint16 相位值保留原位", rawValue: v });
            return null;
          }
          return wrapTo02pi((v / 65535) * Math.PI * 2);
        }).values;
      }
      const payload: WrappedPhasePayload = {
        frame: { width: req.width, height: req.height, values: normalized, normalizedFrom: req.encoding },
        raw,
        wrapRange,
        channel: req.channel ?? "main",
      };
      return { payload, diagnostics: diags };
    }
    case "amplitude": {
      checkDims(req);
      const diags: ImportDiagnostic[] = [];
      const max = req.encoding === "uint8" ? 255 : req.encoding === "uint16" ? 65535 : Infinity;
      if (!req.amplitudeUnit)
        diags.push({ code: "MISSING_UNIT", message: "振幅未声明单位，按 a.u. 保留，规范化分数不参与物理换算" });
      const { values } = normalizeGrid(req, (v, x, y, d) => {
        if (!Number.isFinite(v) || v < 0 || v > max) {
          d.push({ code: "UNCONVERTIBLE_VALUE_LEFT_IN_PLACE", at: { x, y }, message: "越界振幅值保留原位", rawValue: v });
          return null;
        }
        return req.encoding === "float" ? v : v / max;
      });
      const payload: AmplitudePayload = {
        frame: { width: req.width, height: req.height, values, normalizedFrom: req.encoding },
        raw: { encoding: req.encoding, values: req.values.slice() },
        amplitudeUnit: req.amplitudeUnit ?? "a.u.",
      };
      return { payload, diagnostics: diags };
    }
    case "snr_score": {
      checkDims(req);
      const diags: ImportDiagnostic[] = [];
      const { values } = normalizeGrid(req, (v, x, y, d) => {
        if (!Number.isFinite(v) || v < 0) {
          d.push({ code: "UNCONVERTIBLE_VALUE_LEFT_IN_PLACE", at: { x, y }, message: "非法信噪评分保留原位", rawValue: v });
          return null;
        }
        if (req.encoding === "uint8_pct") return v > 100 ? (d.push({ code: "UNCONVERTIBLE_VALUE_LEFT_IN_PLACE", at: { x, y }, message: "百分比 >100", rawValue: v }), null) : v / 100;
        if (req.encoding === "float_dB") return 1 / (1 + Math.exp(-v / 6)); // sigmoid 仅用于质量图；原始 dB 保留
        return v > 1 ? (d.push({ code: "UNCONVERTIBLE_VALUE_LEFT_IN_PLACE", at: { x, y }, message: "无量纲评分 >1", rawValue: v }), null) : v;
      });
      const payload: SnrScorePayload = {
        frame: { width: req.width, height: req.height, values, normalizedFrom: req.encoding },
        raw: { encoding: req.encoding, values: req.values.slice() },
        scoreUnit: req.encoding === "float_dB" ? "dB" : "dimensionless",
        threshold: req.threshold,
      };
      return { payload, diagnostics: diags };
    }
    case "invalid_mask": {
      checkDims(req);
      const diags: ImportDiagnostic[] = [];
      const values = req.values.map((v, i) => {
        if (typeof v === "boolean") return v;
        if (v === 0 || v === 1) return v === 1;
        diags.push({ code: "UNCONVERTIBLE_VALUE_LEFT_IN_PLACE", at: { x: i % req.width, y: Math.floor(i / req.width) }, message: "非布尔遮罩值按无效处理", rawValue: v });
        return true; // 无法转换的值留在原位置：标记无效并附诊断，而不是静默丢弃
      });
      const payload: InvalidMaskPayload = {
        frame: { width: req.width, height: req.height, values },
        reason: req.reason ?? "imported_invalid",
      };
      return { payload, diagnostics: diags };
    }
    case "wavelength": {
      if (!req.unit) throw new ImportFormatError("BAD_UNIT", "波长必须携带单位 nm/um");
      const diags: ImportDiagnostic[] = [];
      if (!(req.value > 0) || !Number.isFinite(req.value))
        throw new ImportFormatError("BAD_RANGE", "波长必须为正有限值");
      const payload: WavelengthPayload = {
        wavelength: { value: req.value, unit: { unit: req.unit } },
        channel: req.channel ?? "main",
        effectiveWavelength: req.effective
          ? { value: req.effective.value, unit: { unit: req.effective.unit } }
          : undefined,
      };
      return { payload, diagnostics: diags };
    }
    case "incidence_geometry": {
      if (!req.arrangement) throw new ImportFormatError("BAD_GEOMETRY", "缺少入射几何布置");
      if (req.incidenceAngleDeg !== undefined && (req.incidenceAngleDeg < 0 || req.incidenceAngleDeg > 90))
        throw new ImportFormatError("BAD_RANGE", "入射角应在 0..90 度");
      const payload: IncidenceGeometryPayload = {
        arrangement: req.arrangement,
        incidenceAngle:
          req.incidenceAngleDeg === undefined
            ? undefined
            : { value: req.incidenceAngleDeg, unit: { unit: "degree" } },
        passFactor: req.passFactor ?? (req.arrangement === "out_of_plane_normal_incidence" ? 2 : 1),
        sensitivityVectorNote:
          req.sensitivityVectorNote ??
          "h = unwrapped_phase * lambda / (2*pi*passFactor)；法向入射默认双程 passFactor=2",
      };
      return { payload, diagnostics: [] };
    }
    case "calibration_plane": {
      if (!req.anchors.length) throw new ImportFormatError("MISSING_FIELD", "标定面至少需要一个锚点");
      const diags: ImportDiagnostic[] = [];
      const anchors = req.anchors.map((a) => {
        if (typeof a.x !== "number" || typeof a.y !== "number")
          throw new ImportFormatError("MISSING_FIELD", "锚点像素坐标缺失");
        for (const ax of ["x", "y", "z"] as const)
          if (!Number.isFinite(a.physical[ax]))
            diags.push({ code: "UNCONVERTIBLE_VALUE_LEFT_IN_PLACE", at: { x: a.x, y: a.y }, message: `标定锚点 physical.${ax} 无法转换`, rawValue: a.physical[ax] });
        return {
          x: a.x,
          y: a.y,
          physical: {
            x: { value: a.physical.x, unit: { unit: req.lengthUnit ?? "um", coordinateBasis: "calibrated_xy" } },
            y: { value: a.physical.y, unit: { unit: req.lengthUnit ?? "um", coordinateBasis: "calibrated_xy" } },
            z: { value: a.physical.z, unit: { unit: req.lengthUnit ?? "um", reference: "calibration_plane" } },
          },
        };
      });
      const payload: CalibrationPlanePayload = {
        anchors,
        lengthUnit: req.lengthUnit ?? "um",
      };
      return { payload, diagnostics: diags };
    }
    case "cut_edit_history": {
      const diags: ImportDiagnostic[] = [];
      const ids = new Set<string>();
      for (const e of req.edits) {
        if (!e.editId || ids.has(e.editId)) throw new ImportFormatError("MISSING_FIELD", `切口编辑 id 缺失或重复: ${e.editId}`);
        ids.add(e.editId);
        if (e.integerOffset !== null && !Number.isInteger(e.integerOffset))
          diags.push({ code: "UNCONVERTIBLE_VALUE_LEFT_IN_PLACE", message: `切口 ${e.editId} 整周偏移非整数，置 null`, rawValue: e.integerOffset });
      }
      const payload: CutEditHistoryPayload = {
        edits: req.edits.map((e) => ({
          ...e,
          integerOffset: e.integerOffset !== null && Number.isInteger(e.integerOffset) ? e.integerOffset : null,
        })),
        note: req.note ?? "",
      };
      return { payload, diagnostics: diags };
    }
  }
}
