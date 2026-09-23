/**
 * 导入层：
 *  - 接受可复制的小型样例（CSV 网格 + 带单位标量 + 标定面文本）。
 *  - 明确的格式错误 -> ValidationDiagnostic（fatal=true 时不产生实体）。
 *  - 原始表示一律保留（RawCell / rawRepresentation）；派生层才规范化。
 *  - 无法转换的值留在原位置（value:null + issue），绝不为画图而丢弃。
 */
import type {
  GridSpec,
  Iso8601,
  PhysicalScalar,
  RawCell,
  StableId,
  UnitName,
  ValidationDiagnostic,
} from "./types.ts";
import { contentHash, idOf, TWO_PI, wrapTo2Pi, wrapToPi } from "./identity.ts";

export interface CommitMeta {
  committedAt: Iso8601;
  sourceName: string;
  parentId: StableId | null;
  version: number;
}

export interface FrameImport {
  kind: "wrappedPhase" | "amplitude" | "snrScore" | "invalidMask";
  csv: string;
  unit: UnitName;
  sourceName: string;
  convention?: "half-open[-pi,pi)" | "half-open[0,2pi)";
  markedBy?: "operator" | "imported";
  encoding?: string;
}

const PARSER_VERSION = "parser-1.0.0";

export function makeGrid(
  rows: number,
  cols: number,
  pitchM = 5e-6,
): GridSpec {
  return {
    rows,
    cols,
    origin: { r: 0, c: 0 },
    pixelPitch: {
      dr: { value: pitchM, unit: "m" },
      dc: { value: pitchM, unit: "m" },
    },
    axisUnit: "m",
  };
}

export function parseGridCsv(
  csv: string,
  opts: {
    kind: FrameImport["kind"];
    expectRows?: number;
    expectCols?: number;
  },
): { cells: RawCell[]; rows: number; cols: number; diagnostics: ValidationDiagnostic[] } {
  const lines = csv
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const diagnostics: ValidationDiagnostic[] = [];
  if (lines.length === 0) {
    diagnostics.push({
      code: "EMPTY_GRID",
      message: "网格为空",
      fatal: true,
      at: new Date(0).toISOString(),
    });
    return { cells: [], rows: 0, cols: 0, diagnostics };
  }
  const width = lines[0]!.split(",").length;
  const cells: RawCell[] = [];
  lines.forEach((line, r) => {
    const tokens = line.split(",");
    if (tokens.length !== width) {
      diagnostics.push({
        code: "RAGGED_GRID",
        message: `第 ${r} 行列数 ${tokens.length} 与首行 ${width} 不一致`,
        fatal: true,
        at: new Date(0).toISOString(),
        rawPosition: { r, c: 0 },
      });
    }
    tokens.forEach((token, c) => {
      const raw = token.trim();
      cells.push(parseCell(raw, r, c, opts.kind, diagnostics));
    });
  });
  const rows = lines.length;
  const cols = width;
  if (opts.expectRows !== undefined && opts.expectRows !== rows) {
    diagnostics.push({
      code: "GRID_SHAPE_MISMATCH",
      message: `行数 ${rows} 与预期 ${opts.expectRows} 不一致`,
      fatal: true,
      at: new Date(0).toISOString(),
    });
  }
  if (opts.expectCols !== undefined && opts.expectCols !== cols) {
    diagnostics.push({
      code: "GRID_SHAPE_MISMATCH",
      message: `列数 ${cols} 与预期 ${opts.expectCols} 不一致`,
      fatal: true,
      at: new Date(0).toISOString(),
    });
  }
  return { cells, rows, cols, diagnostics };
}

function parseCell(
  raw: string,
  r: number,
  c: number,
  kind: FrameImport["kind"],
  diagnostics: ValidationDiagnostic[],
): RawCell {
  if (raw === "" || /^(n\/a|na|null|nan|x)$/i.test(raw)) {
    return { raw, value: null, issue: "MISSING" };
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    diagnostics.push({
      code: "UNPARSEABLE_CELL",
      message: `单元格 (${r},${c}) 无法解析为数字："${raw}"，保留在原位且不猜测`,
      fatal: false,
      at: new Date(0).toISOString(),
      rawPosition: { r, c },
      rawSnippet: raw,
    });
    return { raw, value: null, issue: "UNPARSEABLE" };
  }
  if (kind === "wrappedPhase") {
    if (num < -Math.PI - 1e-6 || num > TWO_PI + 1e-6) {
      diagnostics.push({
        code: "PHASE_OUT_OF_RANGE",
        message: `包裹相位 (${r},${c})=${num} 超出主值区间 [-π,2π)`,
        fatal: false,
        at: new Date(0).toISOString(),
        rawPosition: { r, c },
        rawSnippet: raw,
      });
      return { raw, value: null, issue: "OUT_OF_RANGE" };
    }
    return { raw, value: num };
  }
  if (kind === "invalidMask") {
    if (![0, 1].includes(num)) {
      diagnostics.push({
        code: "MASK_NOT_BOOLEAN",
        message: `遮罩 (${r},${c})=${num} 不是 0/1`,
        fatal: false,
        at: new Date(0).toISOString(),
        rawPosition: { r, c },
        rawSnippet: raw,
      });
      return { raw, value: null, issue: "NOT_BOOLEAN" };
    }
  }
  if ((kind === "amplitude" || kind === "snrScore") && num < 0) {
    diagnostics.push({
      code: "NEGATIVE_SIGNAL",
      message: `${kind} (${r},${c})=${num} 为负，物理上无效；保留原位置诊断`,
      fatal: false,
      at: new Date(0).toISOString(),
      rawPosition: { r, c },
      rawSnippet: raw,
    });
    return { raw, value: null, issue: "NEGATIVE" };
  }
  return { raw, value: num };
}

const LENGTH_TO_M: Record<string, number> = {
  m: 1,
  mm: 1e-3,
  um: 1e-6,
  µm: 1e-6,
  nm: 1e-9,
};

const ANGLE_TO_RAD: Record<string, number> = {
  rad: 1,
  mrad: 1e-3,
  deg: Math.PI / 180,
  degree: Math.PI / 180,
  "°": Math.PI / 180,
};

export interface ScalarParse {
  scalar: PhysicalScalar | null;
  raw: { text: string; value: number | null; unit: UnitName | null; issue?: string };
  diagnostic?: ValidationDiagnostic;
}

export function parsePhysicalScalar(
  text: string,
  dimension: "length" | "angle",
  at: Iso8601,
): ScalarParse {
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([^\s]*)\s*$/.exec(text.trim());
  if (!m) {
    const raw = { text, value: null, unit: null, issue: "UNPARSEABLE" } as const;
    return {
      scalar: null,
      raw: { ...raw },
      diagnostic: {
        code: "UNPARSEABLE_SCALAR",
        message: `无法解析带单位标量："${text}"，原始值留在原位`,
        fatal: false,
        at,
        rawSnippet: text,
      },
    };
  }
  const value = Number(m[1]);
  const unit = m[2] || (dimension === "length" ? "m" : "rad");
  const table = dimension === "length" ? LENGTH_TO_M : ANGLE_TO_RAD;
  if (!(unit in table)) {
    return {
      scalar: null,
      raw: { text, value, unit, issue: "UNKNOWN_UNIT" },
      diagnostic: {
        code: "UNKNOWN_UNIT",
        message: `未知单位 "${unit}"，原始值留在原位（不静默换算）`,
        fatal: false,
        at,
        rawSnippet: text,
      },
    };
  }
  const canonicalUnit = dimension === "length" ? "m" : "rad";
  return {
    scalar: { value: value * table[unit]!, unit: canonicalUnit },
    raw: { text, value, unit },
  };
}

export function normalizePhaseCells(
  cells: RawCell[],
  convention: "half-open[-pi,pi)" | "half-open[0,2pi)",
): number[] {
  return cells.map((cell) => {
    if (cell.value === null) return NaN;
    return convention === "half-open[-pi,pi)"
      ? wrapToPi(cell.value)
      : wrapTo2Pi(cell.value);
  });
}

export function frameByteHash(csv: string): string {
  return contentHash([PARSER_VERSION, csv]);
}

export function commitIdFor(
  prefix: Parameters<typeof idOf>[0],
  body: unknown,
): StableId {
  return idOf(prefix, body);
}
