import type {
  CutEdge, CutEditHistoryData, Diagnostic, GridData, LoopResidual,
  QualityMapPayload, ComponentMapPayload, CutNetworkPayload,
  UnwrapCandidatePayload, UnwrapPathStep, LoopResidualsPayload,
} from '../shared/types';
import { mulberry32 } from '../shared/rng';

export const TWO_PI = Math.PI * 2;

export const ALGORITHM_VERSIONS = {
  quality_map: 'quality-map/1.0.0',
  component_map: 'component-map/1.0.0',
  cut_network: 'cut-network/1.0.0',
  unwrap_candidate: 'branch-cut-unwrap/1.1.0',
  loop_residuals: 'itoh-residue/1.0.0',
  height_map: 'height-chain/1.0.0',
} as const;

export interface UnwrapParams {
  seed: number;
  strategy: 'quality-guided' | 'raster';
  snrThreshold: number;
}

const idx = (w: number, r: number, c: number) => r * w + c;

function neighbors4(w: number, h: number, i: number): number[] {
  const r = Math.floor(i / w), c = i % w;
  const out: number[] = [];
  if (r > 0) out.push(idx(w, r - 1, c));
  if (r < h - 1) out.push(idx(w, r + 1, c));
  if (c > 0) out.push(idx(w, r, c - 1));
  if (c < w - 1) out.push(idx(w, r, c + 1));
  return out;
}

/** 由切口编辑历史折叠出当前切口网络（切口两侧整周偏移显式表示）。 */
export function foldCutNetwork(history: CutEditHistoryData): CutNetworkPayload {
  const edges = new Map<string, CutEdge>();
  for (const edit of history.edits) {
    if (edit.op === 'add_cut') edges.set(edit.edge.edgeId, { ...edit.edge });
    else if (edit.op === 'remove_cut') edges.delete(edit.edgeId);
    else if (edit.op === 'set_offset') {
      const e = edges.get(edit.edgeId);
      if (e) edges.set(edit.edgeId, { ...e, offset: edit.offset });
    }
  }
  return { edges: [...edges.values()].sort((x, y) => x.edgeId.localeCompare(y.edgeId)), diagnostics: [] };
}

/** 质量图：低振幅区域标记为 low-amplitude，不得参与猜相位。 */
export function computeQualityMap(snr: GridData, mask: GridData, snrThreshold: number): QualityMapPayload {
  const { width: w, height: h } = snr;
  const classes: QualityMapPayload['classes'] = [];
  const holePixels: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (mask.values[i] !== 0) classes.push('masked');
    else if (snr.values[i] < snrThreshold) { classes.push('low-amplitude'); holePixels.push(i); }
    else classes.push('valid');
  }
  const diagnostics: Diagnostic[] = [];
  if (holePixels.length > 0) {
    diagnostics.push({
      code: 'LOW_AMPLITUDE_HOLE',
      message: `低振幅孔洞 ${holePixels.length} 像素：不得猜相位，保持未知`,
      pixels: holePixels,
    });
  }
  return { width: w, height: h, classes, snrThreshold, diagnostics };
}

/** 多连通区划分：有效像素、不跨越切口边的 4 连通分量。 */
export function computeComponentMap(
  quality: QualityMapPayload, cutNet: CutNetworkPayload,
): ComponentMapPayload {
  const { width: w, height: h } = quality;
  const cutBetween = buildCutLookup(cutNet.edges);
  const componentOf: Array<number | null> = new Array(w * h).fill(null);
  let componentCount = 0;
  for (let start = 0; start < w * h; start++) {
    if (quality.classes[start] !== 'valid' || componentOf[start] !== null) continue;
    const cid = componentCount++;
    const stack = [start];
    componentOf[start] = cid;
    while (stack.length) {
      const cur = stack.pop()!;
      for (const nb of neighbors4(w, h, cur)) {
        if (quality.classes[nb] !== 'valid' || componentOf[nb] !== null) continue;
        if (cutBetween.has(edgeKey(cur, nb))) continue; // 切口阻断连通
        componentOf[nb] = cid;
        stack.push(nb);
      }
    }
  }
  const diagnostics: Diagnostic[] = [];
  if (componentCount > 1) {
    diagnostics.push({
      code: 'MULTI_COMPONENT',
      message: `多连通区：${componentCount} 个分量，分量间整周偏移未知，各自独立定标`,
    });
  }
  return { width: w, height: h, componentOf, componentCount, diagnostics };
}

export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function buildCutLookup(edges: CutEdge[]): Map<string, CutEdge> {
  const m = new Map<string, CutEdge>();
  for (const e of edges) m.set(edgeKey(e.a, e.b), e);
  return m;
}

/** Itoh 主值差：把相位差折回 (-π, π]。 */
export function principalDelta(d: number): number {
  return d - TWO_PI * Math.round(d / TWO_PI);
}

/** 单回路残差（Itoh 条件）：环绕 plaquette 的主值差之和对应的整周数。 */
export function computeLoopResiduals(wrapped: GridData, quality: QualityMapPayload): LoopResidualsPayload {
  const { width: w, height: h } = wrapped;
  const residuals: LoopResidual[] = [];
  for (let r = 0; r < h - 1; r++) {
    for (let c = 0; c < w - 1; c++) {
      const p = [idx(w, r, c), idx(w, r, c + 1), idx(w, r + 1, c + 1), idx(w, r + 1, c)];
      if (p.some((i) => quality.classes[i] !== 'valid')) continue;
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += principalDelta(wrapped.values[p[(k + 1) % 4]] - wrapped.values[p[k]]);
      }
      const residue = Math.round(sum / TWO_PI);
      if (residue !== 0) {
        residuals.push({ plaquette: [r, c], path: p, residue, pathSumRad: sum });
      }
    }
  }
  const diagnostics: Diagnostic[] = residuals.length
    ? [{
        code: 'LOOP_NONCLOSURE',
        message: `循环不闭合：${residuals.length} 个 plaquette 残差非零，不同展开树可能产生整周多解`,
        refs: residuals.map((x) => `plaquette(${x.plaquette[0]},${x.plaquette[1]})`),
      }]
    : [];
  return { residuals, diagnostics };
}

/**
 * 展开：从各种子像素生成生成树，逐像素累积整周数 k。
 * - 低振幅/遮罩像素：k = null，绝不猜相位；
 * - 跨越切口：被阻断，除非按切口边上的显式整周偏移传播；
 * - 记录完整路径与循环残差，支持多树并存（整周多解）。
 */
export function computeUnwrapCandidate(
  wrapped: GridData,
  quality: QualityMapPayload,
  components: ComponentMapPayload,
  cutNet: CutNetworkPayload,
  params: UnwrapParams,
): UnwrapCandidatePayload {
  const { width: w, height: h } = wrapped;
  const n = w * h;
  const kField: Array<number | null> = new Array(n).fill(null);
  const path: UnwrapPathStep[] = [];
  const cutOffsets: UnwrapCandidatePayload['cutOffsets'] = [];
  const cutBetween = buildCutLookup(cutNet.edges);
  const rng = mulberry32(params.seed);

  // 每个连通区独立选种子（质量最高者，种子随机数只做确定性 tie-break）
  const seedsByComponent = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const cid = components.componentOf[i];
    if (cid === null) continue;
    const cur = seedsByComponent.get(cid);
    if (cur === undefined || qualityKey(i) > qualityKey(cur)) seedsByComponent.set(cid, i);
  }
  function qualityKey(i: number): number {
    // 质量类别已保证 valid；用确定性抖动打散平局
    return rng() + (params.strategy === 'raster' ? -i / (n * 10) : 0);
  }

  const boundaryCrossings: number[] = [];
  for (const [, seedPixel] of [...seedsByComponent.entries()].sort((a, b) => a[0] - b[0])) {
    kField[seedPixel] = 0;
    // 质量引导：优先扩展包裹相位梯度更平滑的边；raster：按索引序
    const frontier: Array<{ from: number; to: number; cost: number }> = [];
    const pushFrontier = (from: number) => {
      for (const to of neighbors4(w, h, from)) {
        if (components.componentOf[to] === null || kField[to] !== null) continue;
        const cut = cutBetween.get(edgeKey(from, to));
        const grad = Math.abs(principalDelta(wrapped.values[to] - wrapped.values[from]));
        const jitter = params.strategy === 'quality-guided' ? rng() * 1e-6 : to * 1e-9;
        pushFrontierEntry(frontier, { from, to, cost: cut ? Infinity : grad + jitter });
      }
    };
    function pushFrontierEntry(list: Array<{ from: number; to: number; cost: number }>, e: { from: number; to: number; cost: number }) {
      list.push(e);
      list.sort((x, y) => x.cost - y.cost || x.to - y.to);
    }
    pushFrontier(seedPixel);
    while (frontier.length) {
      const { from, to } = frontier.shift()!;
      if (kField[to] !== null) continue;
      const cut = cutBetween.get(edgeKey(from, to));
      const baseDeltaK = -Math.round((wrapped.values[to] - wrapped.values[from]) / TWO_PI);
      let deltaK = baseDeltaK;
      let viaCutEdgeId: string | undefined;
      if (cut) {
        // 切口两侧整周偏移显式表示：方向对齐到 from->to
        const oriented = cut.a === from ? cut.offset : -cut.offset;
        deltaK = baseDeltaK + oriented;
        viaCutEdgeId = cut.edgeId;
        cutOffsets.push({ edgeId: cut.edgeId, a: from, b: to, offset: oriented });
        boundaryCrossings.push(to);
      }
      kField[to] = (kField[from] ?? 0) + deltaK;
      path.push({ from, to, deltaK, viaCutEdgeId });
      pushFrontier(to);
    }
  }

  const unknowns: UnwrapCandidatePayload['unknowns'] = [];
  for (let i = 0; i < n; i++) {
    if (kField[i] !== null) continue;
    const cls = quality.classes[i];
    unknowns.push({
      pixel: i,
      reason: cls === 'low-amplitude' ? 'LOW_AMPLITUDE_HOLE' : cls === 'masked' ? 'LOW_AMPLITUDE_HOLE' : 'LOW_AMPLITUDE_HOLE',
    });
  }

  const loops = computeLoopResiduals(wrapped, quality);
  const diagnostics: Diagnostic[] = [
    ...quality.diagnostics,
    ...components.diagnostics,
    ...loops.diagnostics,
  ];
  if (boundaryCrossings.length > 0) {
    diagnostics.push({
      code: 'PHASE_CROSSING_BOUNDARY',
      message: `相位跨越边界：${cutOffsets.length} 次跨越切口，整周偏移已显式记录`,
      pixels: boundaryCrossings,
    });
  }
  return {
    seed: params.seed,
    strategy: params.strategy,
    width: w, height: h,
    kField,
    componentOf: components.componentOf,
    componentCount: components.componentCount,
    cutOffsets,
    path,
    loopResiduals: loops.residuals,
    unknowns,
    diagnostics,
  };
}

/** 比较两个候选：逐分量整周偏移差恒定 => 局部一致；否则整周多解。 */
export function compareCandidates(
  a: UnwrapCandidatePayload, b: UnwrapCandidatePayload,
): { locallyConsistent: boolean; perComponentOffset: Array<number | null>; divergentPixels: number[] } {
  const n = a.kField.length;
  const offsets = new Map<number, number>();
  const perComponentOffset: Array<number | null> = [];
  const divergentPixels: number[] = [];
  let consistent = true;
  for (let i = 0; i < n; i++) {
    if (a.kField[i] === null || b.kField[i] === null) continue;
    const cid = a.componentOf[i]!;
    const diff = b.kField[i]! - a.kField[i]!;
    if (!offsets.has(cid)) offsets.set(cid, diff);
    else if (offsets.get(cid) !== diff) {
      consistent = false;
      divergentPixels.push(i);
    }
  }
  const maxCid = Math.max(-1, ...[...offsets.keys()]);
  for (let cid = 0; cid <= maxCid; cid++) perComponentOffset.push(offsets.get(cid) ?? null);
  return { locallyConsistent: consistent, perComponentOffset, divergentPixels };
}
