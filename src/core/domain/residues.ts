import { ALGORITHM_VERSIONS } from "../../shared/constants.js";
import type {
  BranchCutNetworkPayload,
  CutEdge,
  QualityMapPayload,
  ResidueCharge,
  ResidueMapPayload,
} from "../../shared/types.js";
import { at, idx } from "./grid.js";

interface CellInputs {
  width: number;
  height: number;
  phase: (number | null)[];
  amplitude: (number | null)[];
  mask: boolean[];
  ampMax: number;
  amplitudeThreshold: number;
}

/** 2x2 单元残差：环绕包裹差分求和 / 2pi 取整到 -1/0/+1。 */
export function computeResidues(input: CellInputs): ResidueMapPayload {
  const { width: w, height: h, phase, amplitude, mask } = input;
  const charges: ResidueCharge[] = [];
  const unknownCells: ResidueMapPayload["unknownCells"] = [];
  const lowAmp = (x: number, y: number) => {
    const a = amplitude[idx(w, x, y)];
    return a === null || a < input.amplitudeThreshold * input.ampMax;
  };
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const corners = [
        { x, y },
        { x: x + 1, y },
        { x: x + 1, y: y + 1 },
        { x, y: y + 1 },
      ];
      const unknownCorner = corners.find((p) => mask[idx(w, p.x, p.y)] || phase[idx(w, p.x, p.y)] === null);
      if (unknownCorner) {
        unknownCells.push({
          x,
          y,
          reason: mask[idx(w, unknownCorner.x, unknownCorner.y)]
            ? "invalid_mask"
            : lowAmp(unknownCorner.x, unknownCorner.y)
              ? "low_amplitude"
              : "phase_unknown",
        });
        continue;
      }
      let sum = 0;
      for (let i = 0; i < 4; i++) {
        const a = corners[i];
        const b = corners[(i + 1) % 4];
        let d = (phase[idx(w, b.x, b.y)] as number) - (phase[idx(w, a.x, a.y)] as number);
        while (d > Math.PI) d -= Math.PI * 2;
        while (d <= -Math.PI) d += Math.PI * 2;
        sum += d;
      }
      const q = Math.round(sum / (Math.PI * 2));
      if (q !== 0) charges.push({ x, y, charge: q > 0 ? 1 : -1, wrapIntegral: sum });
    }
  }
  return { charges, unknownCells, algorithmVersion: ALGORITHM_VERSIONS.residue };
}

export interface BranchCutResult {
  network: BranchCutNetworkPayload;
  /** edgeKey "x1,y1-x2,y2" （排序后） -> 切口边 */
  edgeByKey: Map<string, CutEdge>;
}

function keyOf(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const p = [a, b].map((p) => `${p.x},${p.y}`).sort();
  return `${p[0]}-${p[1]}`;
}

function manhattan(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** 最近邻配对异号残差，沿曼哈顿路径放置切口；不能配对的残差引到边界。 */
export function computeBranchCuts(
  residues: ResidueMapPayload,
  importedEdges: CutEdge[],
  parameterFingerprint: string,
  w: number,
  h: number,
): BranchCutResult {
  const edges: CutEdge[] = [...importedEdges];
  const edgeByKey = new Map<string, CutEdge>();
  for (const e of importedEdges) edgeByKey.set(keyOf(e.a, e.b), e);
  let edgeSeq = edges.length;
  const plus = residues.charges.filter((c) => c.charge === 1).map((c) => ({ ...c, used: false }));
  const minus = residues.charges.filter((c) => c.charge === -1).map((c) => ({ ...c, used: false }));

  const placeSegment = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    integerOffset: number | null,
    source: CutEdge["source"],
    pairing?: CutEdge["pairing"],
    diagnostic?: string,
  ) => {
    const a = { ...from };
    const total = manhattan(from, to);
    let remaining = total;
    const step = () => {
      if (a.x !== to.x) a.x += Math.sign(to.x - a.x);
      else if (a.y !== to.y) a.y += Math.sign(to.y - a.y);
    };
    let prev = { ...from };
    step();
    while (remaining > 0) {
      const cur = { ...a };
      const k = keyOf(prev, cur);
      if (!edgeByKey.has(k)) {
        const edge: CutEdge = {
          edgeId: `cut_${String(edgeSeq++).padStart(4, "0")}`,
          a: { ...prev },
          b: { ...cur },
          integerOffset,
          source,
          pairing,
          diagnostic,
        };
        edges.push(edge);
        edgeByKey.set(k, edge);
      }
      prev = cur;
      remaining -= 1;
      if (remaining > 0) step();
    }
  };

  for (const p of plus) {
    if (p.used) continue;
    let best: (typeof minus)[number] | undefined;
    let bestD = Infinity;
    for (const m of minus) {
      if (m.used) continue;
      const d = manhattan(p, m);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    if (best) {
      p.used = true;
      best.used = true;
      // 整周偏移沿路径无法从像素局部判定时保持显式未知是不允许的：
      // 配对残差之间路径的净偏移 = 残差电荷，这里给出显式 +1（约定从 + 到 -）。
      placeSegment(p, best, 1, "residue_pairing", { plus: { x: p.x, y: p.y }, minus: { x: best.x, y: best.y } });
    } else {
      // 未配对：引到最近边界；低振幅孔洞可能让偏移无法闭合 → 显式 null + 诊断（禁止猜）
      const border = p.x <= w - 2 - p.x && p.x <= p.y && p.x <= h - 2 - p.y
        ? { x: -1, y: p.y }
        : p.x >= w - 2 - p.x && w - 2 - p.x <= p.y && w - 2 - p.x <= h - 2 - p.y
          ? { x: w - 1, y: p.y }
          : p.y <= h - 2 - p.y
            ? { x: p.x, y: -1 }
            : { x: p.x, y: h - 1 };
      placeSegment(
        p,
        border,
        null,
        "residue_pairing",
        undefined,
        "unpaired_residue_to_border：路径净整周偏移无法在域内闭合，禁止猜测",
      );
    }
  }

  return {
    network: { edges, algorithmVersion: ALGORITHM_VERSIONS.branchCut, parameterFingerprint },
    edgeByKey,
  };
}

/** 质量图：振幅、信噪、距残差距离、遮罩的加权 0..1 分。 */
export function computeQualityMap(
  w: number,
  h: number,
  amplitude: (number | null)[],
  snr: (number | null)[],
  mask: boolean[],
  residues: ResidueMapPayload,
  amplitudeThreshold: number,
): QualityMapPayload {
  const ampMax = Math.max(1e-9, ...amplitude.filter((v): v is number => v !== null));
  const residueDist = new Map<number, number>();
  const sources = residues.charges.map((c) => ({ x: c.x, y: c.y }));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let d = Infinity;
      for (const s of sources) d = Math.min(d, manhattan({ x, y }, s));
      residueDist.set(idx(w, x, y), d);
    }
  }
  const cells: QualityMapPayload["cells"] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(w, x, y);
      if (mask[i]) continue;
      const amp = amplitude[i];
      const ampScore = amp === null ? 0 : Math.min(1, amp / ampMax);
      const snrScore = snr[i] === null ? 0 : Math.max(0, Math.min(1, snr[i] as number));
      const distScore = Math.min(1, (residueDist.get(i) as number) / 3);
      const thresholdGate = amp === null || amp < amplitudeThreshold * ampMax ? 0.15 : 1;
      const score = (0.45 * ampScore + 0.35 * snrScore + 0.2 * distScore) * thresholdGate;
      cells.push({
        x,
        y,
        score: Math.round(score * 1000) / 1000,
        reasons: ["amplitude", "snr", "distance_to_residue", ...(mask[i] ? (["mask"] as const) : [])],
      });
    }
  }
  return { cells, width: w, height: h, algorithmVersion: ALGORITHM_VERSIONS.quality };
}

export { keyOf as cutEdgeKey, at as gridAt };
