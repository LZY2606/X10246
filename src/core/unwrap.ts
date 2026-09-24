import type {
  ComponentPayload, CutNetworkPayload, CycleResidual, Grid, QualityPayload,
  UnwrapPayload,
} from '../shared/domain';
import { idx } from './grid';
import { wrapAngle } from './phase';
import { cutEdgeSet } from './cuts';

const NEIGH: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * 在每个连通区内建立展开树（不跨越切口、不经过低质量像素）。
 * 整周场 k 沿树传播；低振幅/低信噪像素保持未知（NaN），绝不猜测。
 * 不同树策略得到局部一致解，路径（父指针）与展开后循环残差全部保留。
 * 连通区之间的全局整周偏移由候选决定（整周多解）。
 */
export function unwrap(
  wrapped: Grid,
  quality: QualityPayload,
  components: ComponentPayload,
  cuts: CutNetworkPayload,
  strategy: 'bfs' | 'quality',
  globalOffsets: Record<number, number>,
  familyId: string,
  candidateIndex: number,
): UnwrapPayload {
  const { width, height } = wrapped;
  const k: number[] = new Array(width * height).fill(NaN);
  const parents = new Array(width * height).fill(-1);
  const unknown: number[] = [];
  const roots: Record<number, [number, number]> = {};
  const blocked = cutEdgeSet(cuts);

  for (let comp = 1; comp <= components.componentCount; comp++) {
    const seeds: number[] = [];
    for (let i = 0; i < wrapped.values.length; i++) {
      if (components.grid.values[i] === comp && quality.grid.values[i] > 0) seeds.push(i);
    }
    if (seeds.length === 0) {
      for (let i = 0; i < wrapped.values.length; i++) {
        if (components.grid.values[i] === comp) unknown.push(i);
      }
      continue;
    }
    if (strategy === 'bfs') bfsTree(comp, seeds[0]!, k);
    else qualityTree(comp, seeds, k);
    const ri = seeds[0]!;
    roots[comp] = [ri % width, (ri / width) | 0];
    const off = globalOffsets[comp] ?? 0;
    for (let i = 0; i < k.length; i++) {
      if (components.grid.values[i] === comp) {
        if (Number.isFinite(k[i])) k[i] = k[i] + off;
        else unknown.push(i);
      }
    }
  }

  const phi: Grid = {
    width, height, unit: 'rad', coordFrame: 'detector-pixel',
    values: k.map((kv, i) => (Number.isFinite(kv) ? wrapped.values[i] + 2 * Math.PI * kv : NaN)),
  };
  const kGrid: Grid = { width, height, unit: 'turn', coordFrame: 'detector-pixel', values: k };
  const cycleResidualsAfter = verifyCycles(wrapped, k, blocked);

  return {
    grid: phi,
    kGrid,
    strategy,
    componentRoots: roots,
    globalOffsets,
    treeParents: parents,
    unknownPixels: dedupSorted(unknown),
    cycleResidualsAfter,
    cutOffsets: cuts.cuts.map((c) => ({ ...c, polyline: c.polyline.map((p) => [...p] as [number, number]) })),
    familyId,
    candidateIndex,
  };

  function bfsTree(comp: number, root: number, kk: number[]) {
    kk[root] = 0;
    const queue = [root];
    while (queue.length) {
      const p = queue.shift()!;
      const px = p % width, py = (p / width) | 0;
      for (const [dx, dy] of NEIGH) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const c = idx(wrapped, nx, ny);
        if (components.grid.values[c] !== comp || quality.grid.values[c] <= 0 || Number.isFinite(kk[c])) continue;
        if (blocked.has(edgeKey(p, c))) continue;
        kk[c] = propagateK(wrapped.values[p], wrapped.values[c], kk[p]);
        parents[c] = p;
        queue.push(c);
      }
    }
  }

  function qualityTree(comp: number, seeds: number[], kk: number[]) {
    const root = seeds.reduce((a, b) => (quality.grid.values[b] > quality.grid.values[a] ? b : a));
    kk[root] = 0;
    const frontier = [root];
    while (frontier.length) {
      let bi = 0;
      for (let i = 1; i < frontier.length; i++) {
        if (quality.grid.values[frontier[i]!] > quality.grid.values[frontier[bi]!]
          || (quality.grid.values[frontier[i]!] === quality.grid.values[frontier[bi]!] && frontier[i]! < frontier[bi]!)) {
          bi = i;
        }
      }
      const p = frontier.splice(bi, 1)[0]!;
      const px = p % width, py = (p / width) | 0;
      for (const [dx, dy] of NEIGH) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const c = idx(wrapped, nx, ny);
        if (components.grid.values[c] !== comp || quality.grid.values[c] <= 0 || Number.isFinite(kk[c])) continue;
        if (blocked.has(edgeKey(p, c))) continue;
        kk[c] = propagateK(wrapped.values[p], wrapped.values[c], kk[p]);
        parents[c] = p;
        frontier.push(c);
      }
    }
  }
}

function edgeKey(a: number, b: number) {
  return a < b ? `${a}>${b}` : `${b}>${a}`;
}

export function propagateK(psiParent: number, psiChild: number, kParent: number): number {
  const raw = psiChild - psiParent;
  const d = wrapAngle(raw);
  const jumps = Math.round((raw - d) / (2 * Math.PI));
  return kParent - jumps;
}

/** 展开后逐环验证：未知像素 -> 不可验证；切口穿环 -> 标注；其余残差应为 0 */
function verifyCycles(wrapped: Grid, k: number[], blocked: Set<string>): CycleResidual[] {
  const { width, height } = wrapped;
  const out: CycleResidual[] = [];
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const a = idx(wrapped, x, y);
      const b = idx(wrapped, x + 1, y);
      const c = idx(wrapped, x + 1, y + 1);
      const d = idx(wrapped, x, y + 1);
      const corners: Array<[number, number]> = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]];
      const ks = [k[a], k[b], k[c], k[d]];
      if (ks.some((v) => !Number.isFinite(v))) {
        out.push({ corners, residualRad: NaN, charged: false, unverifiable: true });
        continue;
      }
      const pis = [a, b, c, d].map((pi, j2) => wrapped.values[pi] + 2 * Math.PI * ks[j2]!);
      const r = (pis[1]! - pis[0]!) + (pis[2]! - pis[1]!) + (pis[3]! - pis[2]!) + (pis[0]! - pis[3]!);
      const blockedByCut = [edgeKey(a, b), edgeKey(b, c), edgeKey(c, d), edgeKey(d, a)].some((e) => blocked.has(e));
      out.push({ corners, residualRad: r, charged: Math.abs(r) > 1e-6, blockedByCut });
    }
  }
  return out;
}

function dedupSorted(xs: number[]): number[] {
  return [...new Set(xs)].sort((a, b) => a - b);
}
