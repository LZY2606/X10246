import { edgeId, wrapRad, wrappedDelta } from "./grid";
import type {
  BranchCut,
  BranchCutNetwork,
  CutEditHistory,
  InvalidMask,
  Residue,
  ResidueMap,
  WrappedPhaseFrame
} from "../shared/types";

/**
 * 残差点（Goldstein 电荷）：对每个 2x2 小回路，
 * sum = w(1-0) + w(2-1) + w(3-2) + w(0-3)，
 * 取整到最近的 2π：+1 / -1，0=无残差。
 * 任一角落无效（孔洞/遮拦）则不计算该回路。
 */
export function computeResidues(
  phase: WrappedPhaseFrame,
  mask: InvalidMask
): ResidueMap {
  const { rows, cols, phaseRad } = phase;
  const residues: Residue[] = [];
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      const p0 = r * cols + c;
      const p1 = p0 + 1;
      const p2 = p0 + cols + 1;
      const p3 = p0 + cols;
      if ([p0, p1, p2, p3].some((p) => mask.invalid[p] || phaseRad[p] === null || phaseRad[p] === undefined)) {
        continue;
      }
      const d01 = wrappedDelta(phaseRad, p0, p1)!;
      const d12 = wrappedDelta(phaseRad, p1, p2)!;
      const d23 = wrappedDelta(phaseRad, p2, p3)!;
      const d30 = wrappedDelta(phaseRad, p3, p0)!;
      const sum = wrapRad(d01 + d12 + d23 + d30);
      const q = Math.round(sum / (2 * Math.PI));
      if (q === 1 || q === -1) {
        residues.push({ pixel: p0, charge: q as 1 | -1, wrapSum: sum });
      }
    }
  }
  return { kind: "residue_map", rows, cols, residues };
}

/** 残差像素之间的曼哈顿距离 */
function manhattan(a: number, b: number, cols: number): number {
  return Math.abs(Math.floor(a / cols) - Math.floor(b / cols)) + Math.abs((a % cols) - (b % cols));
}

/**
 * 支路切口网络：
 * 1) 编辑历史中的人工切口始终保留（不可覆盖）；
 * 2) 最近邻配对 +1/-1 残差，切口为两端像素间的直连边（显式 edgeId）；
 * 3) 无法配对的残差进入 unbalancedResidues（循环不闭合的来源之一）。
 */
export function buildBranchCuts(
  residueMap: ResidueMap,
  history: CutEditHistory | null,
  mask: InvalidMask
): BranchCutNetwork {
  const { cols } = residueMap;
  const cuts: BranchCut[] = [];
  const seen = new Set<string>();

  for (const edit of history?.edits ?? []) {
    if (edit.action === "add_cut" || edit.action === "force_connect") {
      const key = edgeId(edit.endpoints[0], edit.endpoints[1]);
      if (!seen.has(key)) {
        seen.add(key);
        cuts.push({ edgeId: key, endpoints: edit.endpoints, source: "manual", editId: edit.editId });
      }
    }
  }

  const positives = residueMap.residues.filter((r) => r.charge === 1).map((r) => r.pixel);
  const negatives = new Set(residueMap.residues.filter((r) => r.charge === -1).map((r) => r.pixel));
  const usedNegative = new Set<number>();
  const balancedPositive = new Set<number>();

  const ordered = [...positives].sort((a, b) => a - b);
  for (const p of ordered) {
    let best: number | null = null;
    let bestD = Infinity;
    for (const n of negatives) {
      if (usedNegative.has(n)) continue;
      if (mask.invalid[n]) continue;
      const d = manhattan(p, n, cols);
      if (d < bestD || (d === bestD && (best === null || n < best))) {
        best = n;
        bestD = d;
      }
    }
    if (best !== null && bestD <= Math.max(residueMap.rows, residueMap.cols)) {
      usedNegative.add(best);
      balancedPositive.add(p);
      const key = edgeId(p, best);
      if (!seen.has(key)) {
        seen.add(key);
        cuts.push({ edgeId: key, endpoints: [p, best], source: "dipole" });
      }
    }
  }

  const unbalancedResidues = residueMap.residues
    .map((r) => r.pixel)
    .filter((p) => {
      const isPos = positives.includes(p);
      const isNeg = negatives.has(p);
      if (isPos) return !balancedPositive.has(p);
      if (isNeg) return !usedNegative.has(p);
      return false;
    })
    .sort((a, b) => a - b);

  return { kind: "branch_cut_network", cuts, unbalancedResidues };
}
