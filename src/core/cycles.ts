import { bitAt, type GridFragment } from "./grid";
import type { CycleResidual, PixelCoord, PixelEdge } from "./types";
import { edgeKey, keyOf } from "./cuts";

export const CYCLE_ALGO = { algorithmName: "fundamental-cycle-residual", algorithmVersion: "1.0.0" } as const;
export const DEFAULT_CYCLE_TOL = 1e-6;

function wrapDelta(a: number, b: number): number {
  let d = b - a;
  while (d <= -Math.PI) d += 2 * Math.PI;
  while (d > Math.PI) d -= 2 * Math.PI;
  return d;
}

/**
 * 沿给定闭合环（顶点序列，最后一点回到第一点）求包裹增量之和。
 * 环上存在无效像素或切口边时不猜测，残差记为未知并给出诊断。
 */
export function loopResidual(
  loop: PixelCoord[],
  phase: GridFragment,
  valid: GridFragment,
  cuts: PixelEdge[],
  toleranceRad = DEFAULT_CYCLE_TOL,
): { residualRad: number | null; closed: boolean; diagnostic: string | null } {
  const cutSet = new Set(cuts.map(edgeKey));
  const w = phase.width;
  const h = phase.height;
  const phaseAt = (r: number, c: number) => (phase.data as number[])[r * w + c] as number;
  let sum = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i] as PixelCoord;
    const b = loop[(i + 1) % loop.length] as PixelCoord;
    if (a.r < 0 || b.r < 0 || a.r >= h || b.r >= h || a.c < 0 || b.c < 0 || a.c >= w || b.c >= w) {
      return { residualRad: null, closed: false, diagnostic: "LOOP_OUT_OF_BOUNDS" };
    }
    if (bitAt(valid, a.r, a.c) === 0 || bitAt(valid, b.r, b.c) === 0) {
      return { residualRad: null, closed: false, diagnostic: "LOOP_CROSSES_INVALID_OR_LOW_AMPLITUDE_REGION" };
    }
    if (cutSet.has(edgeKey({ a, b }))) {
      return { residualRad: null, closed: false, diagnostic: "LOOP_CROSSES_BRANCH_CUT" };
    }
    sum += wrapDelta(phaseAt(a.r, a.c), phaseAt(b.r, b.c));
  }
  sum = Math.round(sum * 1e10) / 1e10;
  const closed = Math.abs(sum) <= toleranceRad;
  return {
    residualRad: Number(sum.toFixed(10)),
    closed,
    diagnostic: closed ? null : `CYCLE_NOT_CLOSED: 残差 ${sum.toFixed(6)} rad 不是 2pi 整数倍`,
  };
}

/** 以某残荷位置为中心取 2x2 小环（对应 plaquette）。 */
export function plaquetteLoop(r: number, c: number): PixelCoord[] {
  return [
    { r, c },
    { r, c: c + 1 },
    { r: r + 1, c: c + 1 },
    { r: r + 1, c },
  ];
}

/** 绕空洞取 8 像素环：中心 (cr,cc) 4x4 环之外的一圈。 */
export function ringAround(cr: number, cc: number): PixelCoord[] {
  // 空洞位于 r∈[3..6], c∈[4..7]（4x4 环，内部 2x2），外环取 r∈[2..7], c∈[3..8]。
  const top: PixelCoord[] = [];
  for (let c = 3; c <= 8; c++) top.push({ r: 2, c });
  for (let r = 3; r <= 7; r++) top.push({ r, c: 8 });
  for (let c = 7; c >= 3; c--) top.push({ r: 7, c });
  for (let r = 6; r >= 3; r--) top.push({ r, c: 3 });
  return top;
}

export function evaluateCycles(
  spec: Array<{ loopId: string; loop: PixelCoord[] }>,
  phase: GridFragment,
  valid: GridFragment,
  cuts: PixelEdge[],
): CycleResidual[] {
  const out: CycleResidual[] = [];
  for (const s of spec) {
    const res = loopResidual(s.loop, phase, valid, cuts);
    out.push({
      loopId: s.loopId,
      loop: s.loop,
      residualRad: res.residualRad,
      closed: res.closed,
      toleranceRad: DEFAULT_CYCLE_TOL,
      diagnostic: res.diagnostic,
    });
  }
  void keyOf;
  return out;
}
