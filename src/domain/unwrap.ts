// 相位展开引擎：质量引导生成树 + 支路切口 + 循环残差 + 整周多解。
// 规则：
//  - 低振幅区域不得猜相位（unwrapped = null，记 LowAmplitudeNoGuess）
//  - 切口两侧的整周偏移显式表示（CutOffset + CutOffsetDeclared）
//  - 不同展开树可得到局部一致解，保留路径与循环残差（TreeVariantKept / CycleNonClosure）
import { contentHash, paramFingerprint, type GridQuantity } from './core.ts';
import type {
  BranchCut,
  CutOffset,
  CycleResidual,
  DomainEvent,
  UnwrapCandidate,
} from './model.ts';

export const UNWRAP_ALGO_VERSION = 'unwrap/1.0.0';

export interface UnwrapInput {
  phase: GridQuantity; // rad, pixel
  snr: GridQuantity; // ratio
  lowAmplitudeThreshold: number;
  invalidMask: boolean[][];
  cuts: BranchCut[];
}

export interface UnwrapParams {
  cycleClosureToleranceRad: number;
  maxCandidatesPerComponent: number;
}

export const DEFAULT_UNWRAP_PARAMS: UnwrapParams = {
  cycleClosureToleranceRad: Math.PI / 2,
  maxCandidatesPerComponent: 4,
};

export interface UnwrapOutput {
  candidates: UnwrapCandidate[];
  events: DomainEvent[];
  components: string[][];
  paramsFingerprint: string;
}

function wrapToPi(x: number): number {
  let v = x % (2 * Math.PI);
  if (v <= -Math.PI) v += 2 * Math.PI;
  if (v > Math.PI) v -= 2 * Math.PI;
  return v;
}

interface Pxl {
  r: number;
  c: number;
}

export function runUnwrap(input: UnwrapInput, params: UnwrapParams = DEFAULT_UNWRAP_PARAMS): UnwrapOutput {
  const rows = input.phase.values.length;
  const cols = input.phase.values[0]?.length ?? 0;
  const events: DomainEvent[] = [];

  // 1) 有效像素 = 非无效遮罩 且 信噪评分不低于阈值；低振幅像素不得猜相位。
  const valid: boolean[][] = [];
  const lowAmpPixels: Array<[number, number]> = [];
  for (let r = 0; r < rows; r++) {
    valid.push(new Array(cols).fill(false));
    for (let c = 0; c < cols; c++) {
      if (input.invalidMask[r]?.[c]) continue;
      if (input.snr.values[r][c] < input.lowAmplitudeThreshold) {
        lowAmpPixels.push([r, c]);
        continue;
      }
      valid[r][c] = true;
    }
  }
  if (lowAmpPixels.length > 0) {
    events.push({
      type: 'LowAmplitudeNoGuess',
      pixels: lowAmpPixels,
      threshold: input.lowAmplitudeThreshold,
      rule: 'low-amplitude-no-guess',
    });
  }

  // 2) 连通分量（4-邻域，多连通区各自独立展开）。
  const compIdOf: (number | null)[][] = Array.from({ length: rows }, () => new Array(cols).fill(null));
  const components: Pxl[][] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!valid[r][c] || compIdOf[r][c] !== null) continue;
      const comp: Pxl[] = [];
      const stack: Pxl[] = [{ r, c }];
      compIdOf[r][c] = components.length;
      while (stack.length > 0) {
        const p = stack.pop()!;
        comp.push(p);
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nr = p.r + dr;
          const nc = p.c + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          if (valid[nr][nc] && compIdOf[nr][nc] === null) {
            compIdOf[nr][nc] = components.length;
            stack.push({ r: nr, c: nc });
          }
        }
      }
      components.push(comp);
    }
  }

  // 3) 循环残差：对每个 2x2 有效片元沿闭合回路积分包裹梯度。
  const cycleResiduals: CycleResidual[] = [];
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      if (!(valid[r][c] && valid[r][c + 1] && valid[r + 1][c + 1] && valid[r + 1][c])) continue;
      const ph = input.phase.values;
      const residual =
        wrapToPi(ph[r][c + 1] - ph[r][c]) +
        wrapToPi(ph[r + 1][c + 1] - ph[r][c + 1]) +
        wrapToPi(ph[r + 1][c] - ph[r + 1][c + 1]) +
        wrapToPi(ph[r][c] - ph[r + 1][c]);
      const closes = Math.abs(residual) < params.cycleClosureToleranceRad;
      const cycle: CycleResidual = {
        cycleId: `cycle_${r}_${c}`,
        loop: [
          [r, c],
          [r, c + 1],
          [r + 1, c + 1],
          [r + 1, c],
        ],
        residual: { value: residual, unit: 'rad', frame: 'pixel' },
        closes,
      };
      cycleResiduals.push(cycle);
      if (!closes) {
        events.push({
          type: 'CycleNonClosure',
          cycleId: cycle.cycleId,
          residual: cycle.residual,
          rule: 'keep-path-and-cycle-residual',
        });
      }
    }
  }

  // 4) 每个分量：质量引导生成树展开；含不闭合回路时保留整周多解与第二棵树。
  const candidates: UnwrapCandidate[] = [];
  const fingerprint = paramFingerprint({ algo: UNWRAP_ALGO_VERSION, params });

  const buildTree = (comp: Pxl[], seed: Pxl, order: Array<[number, number]>) => {
    const parent = new Map<string, Pxl | null>();
    const key = (p: Pxl) => `${p.r},${p.c}`;
    const visited = new Set<string>([key(seed)]);
    const queue: Pxl[] = [seed];
    parent.set(key(seed), null);
    const path: Pxl[] = [seed];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const neighbors: Pxl[] = [];
      for (const [dr, dc] of order) {
        const nr = cur.r + dr;
        const nc = cur.c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        if (!valid[nr][nc] || compIdOf[nr][nc] !== compIdOf[cur.r][cur.c]) continue;
        if (visited.has(`${nr},${nc}`)) continue;
        neighbors.push({ r: nr, c: nc });
      }
      // 质量优先，同分按坐标定序（确定性）。
      neighbors.sort(
        (a, b) =>
          input.snr.values[b.r][b.c] - input.snr.values[a.r][a.c] || a.r - b.r || a.c - b.c,
      );
      for (const n of neighbors) {
        visited.add(key(n));
        parent.set(key(n), cur);
        queue.push(n);
        path.push(n);
      }
    }
    return { parent, path };
  };

  const unwrapAlongPath = (comp: Pxl[], seed: Pxl, path: Pxl[], parent: Map<string, Pxl | null>) => {
    const out: (number | null)[][] = Array.from({ length: rows }, () => new Array(cols).fill(null));
    const ph = input.phase.values;
    out[seed.r][seed.c] = ph[seed.r][seed.c];
    const key = (p: Pxl) => `${p.r},${p.c}`;
    for (const p of path) {
      if (p.r === seed.r && p.c === seed.c) continue;
      const par = parent.get(key(p));
      if (!par) continue;
      out[p.r][p.c] = (out[par.r][par.c] as number) + wrapToPi(ph[p.r][p.c] - ph[par.r][par.c]);
    }
    return out;
  };

  const bestSeed = (comp: Pxl[]): Pxl =>
    [...comp].sort(
      (a, b) =>
        input.snr.values[b.r][b.c] - input.snr.values[a.r][a.c] || a.r - b.r || a.c - b.c,
    )[0];

  const componentCycles = (compIdx: number): CycleResidual[] =>
    cycleResiduals.filter(
      (cy) => !cy.closes && cy.loop.some(([r, c]) => compIdOf[r][c] === compIdx),
    );

  for (let ci = 0; ci < components.length; ci++) {
    const comp = components[ci];
    const componentId = `comp_${ci}`;
    const seed = bestSeed(comp);
    const orderA: Array<[number, number]> = [[0, 1], [1, 0], [0, -1], [-1, 0]];
    const orderB: Array<[number, number]> = [[-1, 0], [0, -1], [1, 0], [0, 1]];
    const treeA = buildTree(comp, seed, orderA);
    const treeIdA = `tree_${componentId}_A`;
    const unwrappedA = unwrapAlongPath(comp, seed, treeA.path, treeA.parent);
    const pathDigestA = contentHash({ tree: treeIdA, path: treeA.path.map((p) => [p.r, p.c]) }).slice(0, 20);

    const badCycles = componentCycles(ci);
    const compCandidates: UnwrapCandidate[] = [];
    const baseCandidate: UnwrapCandidate = {
      candidateId: `cand_${componentId}_k0`,
      treeId: treeIdA,
      componentId,
      unwrapped: unwrappedA,
      offsets: [],
      pathDigest: pathDigestA,
      cycleResiduals: cycleResiduals.filter((cy) => cy.loop.some(([r, c]) => compIdOf[r][c] === ci)),
      status: 'open',
    };
    compCandidates.push(baseCandidate);
    events.push({ type: 'CandidateGenerated', candidateId: baseCandidate.candidateId, treeId: treeIdA, componentId });

    // 整周多解：每个不闭合回路派生 ±2π 的合法候选，全部保留。
    if (badCycles.length > 0) {
      const legalIds: string[] = [baseCandidate.candidateId];
      let kStep = 1;
      for (const cy of badCycles) {
        if (compCandidates.length >= params.maxCandidatesPerComponent) break;
        const pivotRow = cy.loop[0][0];
        const shifted = unwrappedA.map((rowArr, r) =>
          rowArr.map((v, c) =>
            v === null || compIdOf[r][c] !== ci || r <= pivotRow ? v : v + 2 * Math.PI * kStep,
          ),
        );
        const cand: UnwrapCandidate = {
          candidateId: `cand_${componentId}_k${kStep}`,
          treeId: treeIdA,
          componentId,
          unwrapped: shifted,
          offsets: [],
          pathDigest: pathDigestA,
          cycleResiduals: baseCandidate.cycleResiduals,
          status: 'open',
        };
        compCandidates.push(cand);
        legalIds.push(cand.candidateId);
        events.push({ type: 'CandidateGenerated', candidateId: cand.candidateId, treeId: treeIdA, componentId });
        kStep += 1;
      }
      events.push({
        type: 'IntegerAmbiguityKept',
        componentId,
        legalCandidateIds: legalIds,
        rule: 'keep-all-legal-candidates',
      });
    }

    // 第二棵展开树：若得到局部一致解（差值为常数 2π 倍数），两棵都保留。
    const treeB = buildTree(comp, seed, orderB);
    const unwrappedB = unwrapAlongPath(comp, seed, treeB.path, treeB.parent);
    let consistent = true;
    let delta: number | null = null;
    for (const p of comp) {
      const a = unwrappedA[p.r][p.c];
      const b = unwrappedB[p.r][p.c];
      if (a === null || b === null) continue;
      const d = (b as number) - (a as number);
      if (delta === null) delta = d;
      if (Math.abs(d - delta) > 1e-9) {
        consistent = false;
        break;
      }
    }
    if (consistent && delta !== null && Math.abs(wrapToPi(delta)) < 1e-9) {
      const treeIdB = `tree_${componentId}_B`;
      const candB: UnwrapCandidate = {
        candidateId: `cand_${componentId}_treeB`,
        treeId: treeIdB,
        componentId,
        unwrapped: unwrappedB,
        offsets: [],
        pathDigest: contentHash({ tree: treeIdB, path: treeB.path.map((p) => [p.r, p.c]) }).slice(0, 20),
        cycleResiduals: baseCandidate.cycleResiduals,
        status: 'open',
      };
      compCandidates.push(candB);
      events.push({ type: 'CandidateGenerated', candidateId: candB.candidateId, treeId: treeIdB, componentId });
      events.push({
        type: 'TreeVariantKept',
        componentId,
        treeIds: [treeIdA, treeIdB],
        rule: 'keep-path-and-cycle-residual',
      });
    }

    candidates.push(...compCandidates);
  }

  // 5) 切口两侧整周偏移：显式表示（基于基准候选计算）。
  for (const cut of input.cuts) {
    if (cut.polyline.length === 0) continue;
    const [mr, mc] = cut.polyline[Math.floor(cut.polyline.length / 2)];
    const left = { r: Math.round(mr), c: Math.max(0, Math.round(mc) - 1) };
    const right = { r: Math.round(mr), c: Math.min(cols - 1, Math.round(mc) + 1) };
    const compA = compIdOf[left.r]?.[left.c];
    const compB = compIdOf[right.r]?.[right.c];
    if (compA === null || compB === null || compA === undefined || compB === undefined) continue;
    const base = candidates.find((cd) => cd.componentId === `comp_${compA}` && cd.candidateId.endsWith('_k0'))
      ?? candidates.find((cd) => cd.componentId === `comp_${compA}`);
    const baseB = candidates.find((cd) => cd.componentId === `comp_${compB}` && cd.candidateId.endsWith('_k0'))
      ?? candidates.find((cd) => cd.componentId === `comp_${compB}`);
    if (!base || !baseB) continue;
    const ua = base.unwrapped[left.r][left.c];
    const ub = baseB.unwrapped[right.r][right.c];
    if (ua === null || ub === null) continue;
    const wrappedDelta = wrapToPi(input.phase.values[right.r][right.c] - input.phase.values[left.r][left.c]);
    const k = Math.round((ub - ua - wrappedDelta) / (2 * Math.PI));
    const offset: CutOffset = {
      cutId: cut.cutId,
      sideA: `comp_${compA}`,
      sideB: `comp_${compB}`,
      k,
    };
    base.offsets.push(offset);
    events.push({
      type: 'CutOffsetDeclared',
      cutId: cut.cutId,
      sideA: offset.sideA,
      sideB: offset.sideB,
      k,
      rule: 'explicit-cut-offset',
    });
  }

  return {
    candidates,
    events,
    components: components.map((comp, i) => comp.map(() => `comp_${i}`)),
    paramsFingerprint: fingerprint,
  };
}
