import type { SampleInput } from "../src/core/importer.ts";
import { wrap } from "../src/core/algorithm.ts";
import { createRng } from "../src/core/rng.ts";

export const ROWS = 9;
export const COLS = 10;

function makePhase(rows: number, cols: number, opts: { slope: number; wrapBoundary: boolean }): number[] {
  const out: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let phi = opts.slope * c - Math.PI * 0.5;
      if (r >= 3 && r <= 5 && c >= 5) phi += 2.6; // 局部台阶：产生残差/跨越
      out.push(wrap(phi));
    }
  }
  void opts.wrapBoundary;
  return out;
}

export function baselineSample(seed = "case-seed-2026"): SampleInput {
  const rows = ROWS, cols = COLS, n = rows * cols;
  const rng = createRng(seed);
  const amplitude: number[] = [];
  const snr: number[] = [];
  const invalid: boolean[] = [];
  const invalidReason: string[] = [];
  const phase = makePhase(rows, cols, { slope: 0.72, wrapBoundary: true });

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const hole = r >= 3 && r <= 4 && c >= 3 && c <= 3; // 低振幅孔洞
      const masked = r >= 6 && r <= 7 && c >= 7 && c <= 8; // 遮罩块（多连通区）
      amplitude.push(hole ? 0.02 + rng() * 0.01 : 0.55 + rng() * 0.45);
      snr.push(hole ? 0.05 + rng() * 0.05 : 0.5 + rng() * 0.5);
      invalid.push(masked);
      invalidReason.push(masked ? "saturated-detector" : "valid");
      void i;
    }
  }

  return {
    grid: {
      rows,
      cols,
      coordinateBasis: "pixel-grid:row-down,col-right,origin=top-left",
      dx: { value: 0.05, unit: "mm" },
      dy: { value: 0.05, unit: "mm" }
    },
    sourceFile: "fringe-ledger/baseline-frame-001.json",
    wrappedPhase: phase,
    amplitude,
    snr,
    invalid,
    invalidReason,
    wavelength: { value: 632.8, unit: "nm", band: "HeNe" },
    geometry: { incidenceAngle: { value: 30, unit: "deg" }, azimuth: { value: 0, unit: "deg" } },
    calibration: {
      normal: { x: 0, y: 0, z: 1, basis: "lab:z-up" },
      offset: { value: 0, unit: "nm" },
      fitResidualRms: { value: 1.2, unit: "nm" }
    },
    cutEdits: [
      {
        editId: "edit-0001",
        parentEditId: null,
        op: "annotate",
        between: [3 * cols + 4, 3 * cols + 5],
        note: "审阅者标记台阶起点（初始注释）",
        author: "optics-reviewer"
      }
    ]
  };
}

/** 参数修订：缩短最大支路切口长度，改变配对结果。 */
export function revisedParams() {
  return { maxBranchCutLength: 3 };
}

/** 只影响局部依赖的源数据改动：仅修补一个像素的振幅（低振幅孔洞旁）。 */
export function localAmplitudePatch(base: SampleInput): SampleInput {
  const next = structuredClone(base);
  const idx = 3 * COLS + 2;
  next.amplitude![idx] = 0.03; // 使相邻像素也落入低振幅区
  next.sourceFile = base.sourceFile + "#local-patch";
  return next;
}

/** 波长版本变更：HeNe 632.8nm -> 532nm（只影响高度链，不影响展开）。 */
export function revisedWavelength(): SampleInput["wavelength"] {
  return { value: 532, unit: "nm", band: "NdYAG-2nd" };
}

export function phaseWithStrongBoundary(): number[] {
  const out: number[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      let phi = 0.85 * c - 3.0;
      if (c >= 6) phi += 0.5; // 让第 5->6 列稳定跨越 ±π
      out.push(wrap(phi));
    }
  }
  return out;
}
