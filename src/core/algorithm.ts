import type {
  AmplitudeFrame,
  CalibrationSurface,
  CutEditHistory,
  CutEdge,
  CycleResidual,
  HeightChainStep,
  HeightResult,
  IncidenceGeometry,
  InvalidMask,
  QualityMap,
  Residue,
  ResidueMap,
  ResidueCharge,
  CutNetwork,
  SnrScoreFrame,
  TreeEdge,
  UnwrapResult,
  UnwrapTree,
  Wavelength,
  WrappedPhaseFrame,
  CycleResidualSet,
  PixelStatus
} from "../shared/domain.ts";
import { ALGORITHM_VERSION, HEIGHT_CHAIN_VERSION } from "../shared/domain.ts";
import { normalizeDimensioned } from "../shared/units.ts";
import { createRng } from "./rng.ts";

export interface UnwrapParams {
  lowAmplitudePercentile: number; // 振幅低于该分位 => 低振幅孔洞（不猜相位）
  maxBranchCutLength: number;
  minQuality: number;
  alternativeTrees: boolean; // 是否保留第二棵局部一致树（整周多解）
}

export const DEFAULT_PARAMS: UnwrapParams = {
  lowAmplitudePercentile: 0.12,
  maxBranchCutLength: 64,
  minQuality: 0.05,
  alternativeTrees: true
};

const TAU = Math.PI * 2;

export function wrap(x: number): number {
  let y = x % TAU;
  if (y > Math.PI) y -= TAU;
  if (y <= -Math.PI) y += TAU;
  return y;
}

function neighbors4(index: number, rows: number, cols: number): { id: number; dir: number }[] {
  const r = Math.floor(index / cols);
  const c = index % cols;
  const out: { id: number; dir: number }[] = [];
  if (c + 1 < cols) out.push({ id: index + 1, dir: 0 }); // 水平边
  if (r + 1 < rows) out.push({ id: index + cols, dir: 1 }); // 垂直边
  if (c - 1 >= 0) out.push({ id: index - 1, dir: 0 });
  if (r - 1 >= 0) out.push({ id: index - cols, dir: 1 });
  return out;
}

/** 水平边 id = r*(cols-1)+c（连接 (r,c)-(r,c+1)）；垂直边 id=hEdges+c 样式由下方编码区分。 */
function edgeH(rows: number, cols: number, r: number, c: number): number {
  return r * (cols - 1) + c;
}
function edgeV(rows: number, cols: number, r: number, c: number): number {
  return rows * (cols - 1) + r * cols + c;
}
function totalEdges(rows: number, cols: number): number {
  return rows * (cols - 1) + (rows - 1) * cols;
}

// ---------- 质量图 ----------

export function computeQuality(
  phase: WrappedPhaseFrame,
  amplitude: AmplitudeFrame,
  snr: SnrScoreFrame,
  mask: InvalidMask,
  params: UnwrapParams
): QualityMap {
  const { rows, cols } = phase.grid;
  const n = rows * cols;
  const validAmp = amplitude.values.filter((v) => Number.isFinite(v) && v > 0).sort((x, y) => x - y);
  const threshold =
    validAmp.length === 0
      ? 0
      : validAmp[Math.min(validAmp.length - 1, Math.floor(params.lowAmplitudePercentile * validAmp.length))];
  const maxAmp = validAmp.length ? validAmp[validAmp.length - 1] : 1;
  const quality: number[] = new Array(n);
  const pixelState: PixelStatus[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const ampTerm = maxAmp > 0 ? Math.max(0, Math.min(1, amplitude.values[i] / maxAmp)) : 0;
    const snrTerm = Math.max(0, Math.min(1, snr.values[i]));
    quality[i] = Math.round((0.6 * ampTerm + 0.4 * snrTerm) * 1000) / 1000;
    if (mask.invalid[i]) pixelState[i] = "masked";
    else if (amplitude.values[i] <= threshold || amplitude.values[i] <= 0) pixelState[i] = "low-amplitude";
    else pixelState[i] = "valid";
  }
  return {
    kind: "QualityMap",
    grid: phase.grid,
    quality,
    pixelState,
    lowAmplitudeThreshold: threshold
  };
}

// ---------- 残差点（旋度）----------

export function detectResidues(phase: WrappedPhaseFrame, quality: QualityMap): ResidueMap {
  const { rows, cols } = phase.grid;
  const phi = phase.pixels.map((p) => p.phase);
  const residues: Residue[] = [];
  const boundaries: number[] = [];
  const usedBoundary = new Set<number>();

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const p00 = r * cols + c;
      const p01 = p00 + 1;
      const p10 = p00 + cols;
      const p11 = p10 + 1;
      const dTop = wrap(phi[p01] - phi[p00]);
      const dRight = wrap(phi[p11] - phi[p01]);
      const dBottom = wrap(phi[p10] - phi[p11]);
      const dLeft = wrap(phi[p00] - phi[p10]);
      const sum = dTop + dRight + dBottom + dLeft;
      const q = Math.round(sum / TAU) as ResidueCharge;
      if (q !== 0) {
        residues.push({ plaquetteId: r * (cols - 1) + c, anchorPixel: p00, charge: q, loopSum: Math.round(sum * 1e6) / 1e6 });
        [edgeH(rows, cols, r, c), edgeV(rows, cols, r, c + 1), edgeH(rows, cols, r + 1, c), edgeV(rows, cols, r, c)].forEach(
          (e) => usedBoundary.add(e)
        );
      }
    }
  }
  // 相位跨越边界：标记包裹差接近 ±2π 跳变的边
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      if (Math.abs(wrap(phi[r * cols + c + 1] - phi[r * cols + c])) > Math.PI * 0.92)
        boundaries.push(edgeH(rows, cols, r, c));
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
      if (Math.abs(wrap(phi[(r + 1) * cols + c] - phi[r * cols + c])) > Math.PI * 0.92)
        boundaries.push(edgeV(rows, cols, r, c));
    }
  }
  return { kind: "ResidueMap", residues, boundaries: [...new Set(boundaries.concat(Array.from(usedBoundary)))] };
}

// ---------- 支路切口（branch cuts）----------

interface PQ {
  index: number;
  charge: number;
}

function linePixels(a: number, b: number, cols: number): number[] {
  const ra = Math.floor(a / cols), ca = a % cols;
  const rb = Math.floor(b / cols), cb = b % cols;
  const steps = Math.max(Math.abs(rb - ra), Math.abs(cb - ca));
  const out: number[] = [];
  for (let s = 0; s <= steps; s++) {
    const t = steps === 0 ? 0 : s / steps;
    out.push(Math.round(ra + (rb - ra) * t) * cols + Math.round(ca + (cb - ca) * t));
  }
  return out;
}

export function placeCuts(
  phase: WrappedPhaseFrame,
  quality: QualityMap,
  residues: ResidueMap,
  history: CutEditHistory | null,
  params: UnwrapParams,
  seed: string
): CutNetwork {
  const { rows, cols } = phase.grid;
  const n = rows * cols;
  const phi = phase.pixels.map((p) => p.phase);
  const rng = createRng(seed + ":cuts");
  const edges: CutEdge[] = [];
  const edgeKey = new Set<number>();
  let edgeSeq = 1;
  const neutralized: number[] = [];
  const boundaryResidues: number[] = [];

  const addCutSegment = (a: number, b: number, reason: CutEdge["reason"], sealedBy?: string) => {
    const line = linePixels(a, b, cols);
    for (let i = 0; i < line.length - 1; i++) {
      const x = line[i], y = line[i + 1];
      if (x === y) continue;
      // 显式整周偏移：由沿切口方向的包裹相位差决定
      const raw = wrap(phi[y] - phi[x]);
      // unwrapped 期望近似 0，整周 k 使结果落到小范围：k = -round(wrap/2π)
      const k = -Math.round(raw / TAU);
      const key = Math.min(x, y) * n + Math.max(x, y);
      if (edgeKey.has(key)) continue;
      edgeKey.add(key);
      edges.push({
        edgeId: edgeSeq++,
        a: Math.min(x, y),
        b: Math.max(x, y),
        integerOffset: k,
        reason,
        sealedBy
      });
    }
  };

  // 最近邻异号配对（受最大长度限制），其余接到边界/遮罩
  const remaining: PQ[] = residues.residues.map((r) => ({ index: r.anchorPixel, charge: r.charge }));
  const used = new Array(remaining.length).fill(false);
  const dist = (x: number, y: number) => {
    const rx = Math.floor(x / cols), cx = x % cols, ry = Math.floor(y / cols), cy = y % cols;
    return Math.abs(rx - ry) + Math.abs(cx - cy) + rng() * 0.5; // 固定 seed 决定并列
  };
  for (let i = 0; i < remaining.length; i++) {
    if (used[i]) continue;
    let best = -1, bestD = Infinity;
    for (let j = 0; j < remaining.length; j++) {
      if (used[j] || i === j) continue;
      if (remaining[i].charge * remaining[j].charge < 0) {
        const d = dist(remaining[i].index, remaining[j].index);
        if (d < bestD) { bestD = d; best = j; }
      }
    }
    if (best >= 0 && bestD <= params.maxBranchCutLength) {
      addCutSegment(remaining[i].index, remaining[best].index, "residue-pair");
      used[i] = used[best] = true;
      neutralized.push(remaining[i].index, remaining[best].index);
    } else {
      // 接到最近边界
      const p = remaining[i].index;
      const r = Math.floor(p / cols), c = p % cols;
      const targets = [r * cols, r * cols + cols - 1, c, (rows - 1) * cols + c];
      let tb = targets[0], td = Infinity;
      for (const t of targets) {
        const d = dist(p, t);
        if (d < td) { td = d; tb = t; }
      }
      addCutSegment(p, tb, "residue-boundary");
      used[i] = true;
      boundaryResidues.push(p);
    }
  }

  // 低振幅孔洞封口：包围每个孔洞簇的切口（不猜相位，只标示边界整周）
  const holePixels: number[] = [];
  for (let i = 0; i < n; i++) if (quality.pixelState[i] === "low-amplitude") holePixels.push(i);
  for (const h of holePixels) {
    for (const nb of neighbors4(h, rows, cols)) {
      if (quality.pixelState[nb.id] === "valid") {
        const x = Math.min(h, nb.id), y = Math.max(h, nb.id);
        const key = x * n + y;
        if (!edgeKey.has(key)) {
          edgeKey.add(key);
          const raw = wrap(phi[y] - phi[x]);
          edges.push({ edgeId: edgeSeq++, a: x, b: y, integerOffset: -Math.round(raw / TAU), reason: "low-amplitude-hole" });
        }
      }
    }
  }

  // 人工编辑切口（切口编辑历史是不可覆盖输入，这里施加其效果）
  const liveEdits = applyEditHistory(history);
  for (const e of liveEdits) {
    const x = Math.min(e.between[0], e.between[1]), y = Math.max(e.between[0], e.between[1]);
    const key = x * n + y;
    const raw = wrap(phi[y] - phi[x]);
    if (e.op === "add-cut" || e.op === "seal-residue") {
      if (!edgeKey.has(key)) {
        edgeKey.add(key);
        edges.push({ edgeId: edgeSeq++, a: x, b: y, integerOffset: -Math.round(raw / TAU), reason: "manual", sealedBy: e.editId });
      }
    } else if (e.op === "remove-cut") {
      const idx = edges.findIndex((g) => g.a === x && g.b === y && g.sealedBy === undefined);
      if (idx >= 0) edges.splice(idx, 1);
    }
  }

  // 多连通区：在遮罩 + 切口形成的障碍上求连通分量
  const blocked = new Set<number>();
  for (const g of edges) blocked.add(g.a * n + g.b);
  const comps = connectedComponents(rows, cols, quality.pixelState, blocked, n);
  return {
    kind: "CutNetwork",
    edges,
    neutralizedResidues: [...new Set(neutralized)],
    boundaryResidues: [...new Set(boundaryResidues)],
    components: comps
  };
}

function applyEditHistory(history: CutEditHistory | null): CutEditHistory["edits"] {
  if (!history) return [];
  // 追加型历史顺序施加；remove 抵消对应 add
  const live: CutEditHistory["edits"] = [];
  for (const edit of history.edits) {
    if (edit.op === "remove-cut") {
      const idx = live.findIndex((e) => e.between[0] === edit.between[0] && e.between[1] === edit.between[1]);
      if (idx >= 0) live.splice(idx, 1);
    } else {
      live.push(edit);
    }
  }
  return live;
}

function connectedComponents(
  rows: number,
  cols: number,
  state: PixelStatus[],
  blocked: Set<number>,
  n: number
): { pixelIds: number[]; cut: boolean }[] {
  const seen = new Array(n).fill(false);
  const comps: { pixelIds: number[]; cut: boolean }[] = [];
  for (let start = 0; start < n; start++) {
    if (seen[start] || state[start] === "masked") continue;
    const stack = [start];
    const pixels: number[] = [];
    let touchesCut = false;
    seen[start] = true;
    while (stack.length) {
      const cur = stack.pop()!;
      pixels.push(cur);
      for (const nb of neighbors4(cur, rows, cols)) {
        if (state[nb.id] === "masked") continue;
        const x = Math.min(cur, nb.id), y = Math.max(cur, nb.id);
        if (blocked.has(x * n + y)) { touchesCut = true; continue; }
        if (!seen[nb.id]) { seen[nb.id] = true; stack.push(nb.id); }
      }
    }
    comps.push({ pixelIds: pixels, cut: touchesCut });
  }
  return comps.sort((a, b) => b.pixelIds.length - a.pixelIds.length);
}

// ---------- 展开树（不同展开树 => 局部一致解，保留路径与循环残差） ----------

interface SpanningResult {
  edges: TreeEdge[];
  unwrapped: (number | null)[];
  root: number;
  componentPixels: Set<number>;
}

function primTree(
  rows: number,
  cols: number,
  phi: number[],
  state: PixelStatus[],
  blocked: Set<number>,
  quality: number[],
  forcedCut: CutEdge | null,
  rng: () => number,
  component: number[]
): SpanningResult {
  const n = rows * cols;
  const inSet = new Set<number>(component);
  let root = component[0];
  let bestQ = -1;
  for (const p of component) {
    if (state[p] === "valid" && quality[p] > bestQ) { bestQ = quality[p]; root = p; }
  }
  const visited = new Array(n).fill(false);
  const parent: (number | null)[] = new Array(n).fill(null);
  const chosen2pi = new Map<number, number>();
  // 邻接代价：质量越高代价越低；强制切口边代价为负（优先选入），使其成为树边
  const cost = (a: number, b: number): number => {
    const x = Math.min(a, b), y = Math.max(a, b);
    const isForced = forcedCut && x === Math.min(forcedCut.a, forcedCut.b) && y === Math.max(forcedCut.a, forcedCut.b);
    if (isForced) return -1;
    if (blocked.has(x * n + y)) return Infinity;
    if (state[b] === "low-amplitude" || state[a] === "low-amplitude") return Infinity;
    return 2 - quality[a] - quality[b] + rng() * 1e-6;
  };
  const key = new Set<string>();
  const heap: { a: number; b: number; c: number }[] = [];
  const push = (a: number, b: number) => {
    const k = Math.min(a, b) + "-" + Math.max(a, b);
    if (key.has(k)) return;
    key.add(k);
    const c = cost(a, b);
    if (Number.isFinite(c)) heap.push({ a, b, c });
  };
  visited[root] = true;
  for (const nb of neighbors4(root, rows, cols)) if (inSet.has(nb.id)) push(root, nb.id);
  const treeEdges: TreeEdge[] = [];
  let edgeId = 1;
  while (heap.length) {
    let bi = 0;
    for (let i = 1; i < heap.length; i++) if (heap[i].c < heap[bi].c) bi = i;
    const { a, b } = heap.splice(bi, 1)[0];
    if (visited[b]) continue;
    visited[b] = true;
    parent[b] = a;
    const d = wrap(phi[b] - phi[a]);
    // 经过强制切口时，使用其显式整周偏移
    const x = Math.min(a, b), y = Math.max(a, b);
    const acrossForced = forcedCut && x === Math.min(forcedCut.a, forcedCut.b) && y === Math.max(forcedCut.a, forcedCut.b);
    let k2 = 0;
    if (acrossForced) {
      k2 = forcedCut!.integerOffset;
    }
    chosen2pi.set(b, k2);
    treeEdges.push({ edgeId: edgeId++, a, b, wrapDelta: d, chosen2Pi: k2 });
    for (const nb of neighbors4(b, rows, cols)) if (inSet.has(nb.id) && !visited[nb.id]) push(b, nb.id);
  }
  const unwrapped: (number | null)[] = new Array(n).fill(null);
  unwrapped[root] = phi[root];
  const resolve = (p: number): number => {
    if (unwrapped[p] !== null) return unwrapped[p]!;
    const par = parent[p]!;
    const up = resolve(par);
    const d = wrap(phi[p] - phi[par]) + TAU * (chosen2pi.get(p) ?? 0);
    unwrapped[p] = up + d;
    return unwrapped[p]!;
  };
  for (const p of component) if (state[p] !== "low-amplitude") resolve(p);
  return { edges: treeEdges, unwrapped, root, componentPixels: new Set(component) };
}

export function unwrap(
  phase: WrappedPhaseFrame,
  quality: QualityMap,
  cuts: CutNetwork,
  params: UnwrapParams,
  seed: string
): UnwrapResult {
  const { rows, cols } = phase.grid;
  const n = rows * cols;
  const phi = phase.pixels.map((p) => p.phase);
  const blocked = new Set<number>();
  for (const g of cuts.edges) blocked.add(g.a * n + g.b);
  const rng = createRng(seed + ":tree");

  // 在最大（被切口分隔的）有效连通分量上建树；低振幅像素不进树
  const validComponent = cuts.components
    .map((c) => c.pixelIds.filter((p) => quality.pixelState[p] !== "masked" && quality.pixelState[p] !== "low-amplitude"))
    .filter((c) => c.length > 0)
    .sort((a, b) => b.length - a.length)[0] ?? [];

  const trees: UnwrapTree[] = [];
  const unknownPixels: number[] = [];
  for (let i = 0; i < n; i++) if (quality.pixelState[i] === "low-amplitude") unknownPixels.push(i);

  const primary = primTree(rows, cols, phi, quality.pixelState, blocked, quality.quality, null, rng, validComponent);
  const integerCandidates: number[][] = new Array(n).fill(0).map(() => [0]);
  const candidateReasons: Record<string, string> = {};
  for (const p of validComponent) integerCandidates[p] = [0];
  trees.push({
    treeId: "tree-primary",
    label: "最大质量生成树（避开全部支路切口）",
    parentTreeId: null,
    root: primary.root,
    edges: primary.edges,
    unwrapped: primary.unwrapped,
    integerCandidates: integerCandidates.map((c) => [...c]),
    candidateReasons: {}
  });

  const rejected: { treeId: string; reason: string }[] = [];

  // 第二棵树：跨越一条异号残差切口 => 整周多解（局部一致的另一合法候选）
  if (params.alternativeTrees) {
    const cutToCross = cuts.edges.find((g) => g.reason === "residue-pair" && g.integerOffset !== 0)
      ?? cuts.edges.find((g) => g.integerOffset !== 0)
      ?? null;
    if (cutToCross) {
      const rng2 = createRng(seed + ":tree-alt");
      const alt = primTree(rows, cols, phi, quality.pixelState, blocked, quality.quality, cutToCross, rng2, validComponent);
      const altCandidates = integerCandidates.map((c) => [...c]);
      // 跨越切口后，切口另一侧整体偏移 2π*k
      const kAlt = cutToCross.integerOffset;
      const sidePixels = altSidePixels(alt, cutToCross);
      for (const p of sidePixels) {
        if (!altCandidates[p].includes(kAlt)) {
          altCandidates[p] = [0, kAlt];
          candidateReasons[String(p)] = `跨越切口 edge#${cutToCross.edgeId}：整周 k∈{0,${kAlt}} 均局部一致`;
        }
      }
      trees.push({
        treeId: "tree-across-cut",
        label: `跨越切口 edge#${cutToCross.edgeId}（显式整周偏移 ${kAlt}）的替代树`,
        parentTreeId: "tree-primary",
        root: alt.root,
        edges: alt.edges,
        unwrapped: alt.unwrapped,
        integerCandidates: altCandidates,
        candidateReasons
      });
    } else {
      rejected.push({ treeId: "tree-across-cut", reason: "无可用带非零整周偏移的残差切口，无法构造第二棵树" });
    }
  }

  return {
    kind: "UnwrapResult",
    grid: phase.grid,
    trees,
    chosenTreeId: null,
    rejected,
    unknownPixels
  };
}

function altSidePixels(tree: SpanningResult, cut: CutEdge): number[] {
  const edge = tree.edges.find(
    (e) => (e.a === cut.a && e.b === cut.b) || (e.a === cut.b && e.b === cut.a)
  );
  if (!edge) return [];
  const childIs = edge.b;
  const parentMap = new Map<number, number>();
  for (const e of tree.edges) parentMap.set(e.b, e.a);
  const out: number[] = [];
  for (let p = 0; p < tree.unwrapped.length; p++) {
    if (tree.unwrapped[p] === null) continue;
    let cur = p;
    while (cur !== tree.root) {
      if (cur === childIs) { out.push(p); break; }
      const par = parentMap.get(cur);
      if (par === undefined) break;
      cur = par;
    }
  }
  return out;
}

// ---------- 循环残差 ----------

export function evaluateCycles(
  phase: WrappedPhaseFrame,
  quality: QualityMap,
  cuts: CutNetwork,
  tree: UnwrapTree
): CycleResidualSet {
  const { rows, cols } = phase.grid;
  const phi = phase.pixels.map((p) => p.phase);
  const cycles: CycleResidual[] = [];

  // 1) 每个 plaquette（2x2）基本循环：用树路径闭合，检验整周失配
  let ci = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const loop = [r * cols + c, r * cols + c + 1, (r + 1) * cols + c + 1, (r + 1) * cols + c];
      if (loop.some((p) => quality.pixelState[p] === "masked" || quality.pixelState[p] === "low-amplitude")) continue;
      if (loop.some((p) => tree.unwrapped[p] === null)) continue;
      const U = loop.map((p) => tree.unwrapped[p]!);
      const residual =
        wrap(phi[loop[1]] - phi[loop[0]]) +
        wrap(phi[loop[2]] - phi[loop[1]]) +
        wrap(phi[loop[3]] - phi[loop[2]]) +
        wrap(phi[loop[0]] - phi[loop[3]]);
      // 展开值绕环总和应为 0
      const uSum =
        (U[1] - U[0]) + (U[2] - U[1]) + (U[3] - U[2]) + (U[0] - U[3]);
      const mismatch = Math.round(uSum / TAU);
      const acrossCut = loop.some((p, i) => {
        const q = loop[(i + 1) % 4];
        return cuts.edges.some((g) => g.a === Math.min(p, q) && g.b === Math.max(p, q));
      });
      if (Math.abs(mismatch) > 0 || Math.abs(residual) > 1e-6 || acrossCut) {
        cycles.push({
          cycleId: `cycle-pl-${ci++}`,
          pixelLoop: loop,
          wrapResidual: Math.round(residual * 1e6) / 1e6,
          integerMismatch: mismatch,
          closed: mismatch === 0,
          acrossCut
        });
      }
    }
  }

  // 2) 多连通区（孔洞/岛屿）外边界循环
  const holeLoop = boundaryLoopOfHoles(quality);
  if (holeLoop) {
    const known = holeLoop.filter((p) => tree.unwrapped[p] !== null);
    if (known.length === holeLoop.length) {
      let uSum = 0;
      for (let i = 0; i < holeLoop.length; i++) {
        const a = holeLoop[i], b = holeLoop[(i + 1) % holeLoop.length];
        uSum += tree.unwrapped[b]! - tree.unwrapped[a]!;
      }
      const mismatch = Math.round(uSum / TAU);
      cycles.push({
        cycleId: `cycle-hole-${ci++}`,
        pixelLoop: holeLoop,
        wrapResidual: Math.round(wrap(uSum) * 1e6) / 1e6,
        integerMismatch: mismatch,
        closed: mismatch === 0,
        acrossCut: false,
        componentHole: true
      });
    }
  }

  return { kind: "CycleResidualSet", treeId: tree.treeId, cycles };
}

function boundaryLoopOfHoles(quality: QualityMap): number[] | null {
  const { rows, cols } = quality.grid;
  const isHole = (p: number) => quality.pixelState[p] === "low-amplitude" || quality.pixelState[p] === "masked";
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const p00 = r * cols + c;
      if (!isHole(p00)) continue;
      // 找该孔洞的有效外边界 4-8 个像素
      const loop: number[] = [];
      const cand = [
        r * cols + c - 1,
        (r - 1) * cols + c - 1,
        (r - 1) * cols + c,
        (r - 1) * cols + c + 1,
        r * cols + c + 1,
        (r + 1) * cols + c + 1,
        (r + 1) * cols + c,
        (r + 1) * cols + c - 1
      ];
      for (const p of cand) if (p >= 0 && p < rows * cols && !isHole(p)) loop.push(p);
      if (loop.length >= 4) return dedupeConsecutive(loop);
    }
  }
  return null;
}

function dedupeConsecutive(xs: number[]): number[] {
  const out: number[] = [];
  for (const x of xs) if (out[out.length - 1] !== x) out.push(x);
  if (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
  return out;
}

// ---------- 高度转换链（每一步可审计，单位/基准随值携带） ----------

export function convertHeight(
  tree: UnwrapTree,
  wavelength: Wavelength,
  geometry: IncidenceGeometry,
  calibration: CalibrationSurface | null,
  wavelengthDigest: string
): HeightResult {
  const chain: HeightChainStep[] = [];
  const n = tree.unwrapped.length;

  const wl = normalizeDimensioned(wavelength.wavelength);
  const ang = normalizeDimensioned(geometry.incidenceAngle);
  const wlOk = wl.normalized?.convertible && Number.isFinite(wl.normalized.value);
  const angOk = ang.normalized?.convertible && Number.isFinite(ang.normalized.value);

  chain.push({
    stepId: "step-phase-to-opd",
    from: "unwrapped-phase(rad)",
    to: "optical-path-difference(m)",
    formula: "OPD = phi_unwrapped * lambda / (2*pi)",
    inputs: {
      lambda: `${wavelength.wavelength.value} ${wavelength.wavelength.unit}`,
      lambdaNormalized: wlOk ? `${wl.normalized!.value} m` : `不可转换：${wl.diagnostic ?? ""}`
    },
    outputs: [{ value: wlOk ? wl.normalized!.value / TAU : NaN, unit: "m/rad" }]
  });

  const cosTheta = angOk ? Math.cos(ang.normalized!.value) : 1;
  chain.push({
    stepId: "step-opd-to-height",
    from: "optical-path-difference(m)",
    to: "relative-height(m)",
    formula: "h = OPD / (1 + cos(theta)); theta=入射角(相对表面法线)",
    inputs: {
      theta: `${geometry.incidenceAngle.value} ${geometry.incidenceAngle.unit}`,
      cosTheta: angOk ? cosTheta.toFixed(6) : `不可转换：${ang.diagnostic ?? ""}（回退 cos=1）`
    },
    outputs: [{ value: wlOk ? wl.normalized!.value / TAU / (1 + cosTheta) : NaN, unit: "m/rad" }]
  });

  const heights: (number | null)[] = new Array(n).fill(null);
  const scale = wlOk ? wl.normalized!.value / TAU / (1 + cosTheta) : NaN;
  for (let i = 0; i < n; i++) {
    if (tree.unwrapped[i] === null) continue;
    if (!wlOk) { heights[i] = null; continue; } // 无法转换的值留在原位置（不丢、不瞎画）
    let h = tree.unwrapped[i]! * scale;
    if (calibration) {
      // 标定面：减去仿射平面（这里以偏移量为常量修正，法向修正记入链）
      const off = normalizeDimensioned(calibration.model.offset);
      if (off.normalized?.convertible) h -= off.normalized.value;
    }
    heights[i] = h;
  }

  chain.push({
    stepId: "step-calibration",
    from: "relative-height(m)",
    to: "calibrated-height(m)",
    formula: calibration
      ? "h_cal = h - (n·p + d)，n=标定法向，d=偏移；此处应用常量偏移 d 与法向基准"
      : "无标定面：保留相对高度",
    inputs: calibration
      ? {
          normalBasis: calibration.model.normal.basis,
          offset: `${calibration.model.offset.value} ${calibration.model.offset.unit}`,
          fitRms: `${calibration.fitResidualRms.value} ${calibration.fitResidualRms.unit}`
        }
      : {},
    outputs: [{ value: 1, unit: "m/m" }]
  });

  return {
    kind: "HeightResult",
    treeId: tree.treeId,
    heights,
    unit: wlOk ? "m" : `${wavelength.wavelength.unit}?`,
    chain,
    calibrationApplied: calibration !== null && Boolean(wlOk),
    wavelengthDigest
  };
}

export { ALGORITHM_VERSION, HEIGHT_CHAIN_VERSION };
