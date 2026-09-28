import type {
  CycleResidual,
  GridGeometry,
  IntegerCandidate,
  TreeEdge,
  UnwrappedPixel,
  UnwrapPath,
  UnwrapTree,
} from '../shared/model.js';
import type { CutEdge } from '../shared/model.js';
import { TWO_PI, wrap } from './wrap.js';
import { cutBlocksEdge } from './cuts.js';

export interface UnwrapResult {
  trees: UnwrapTree[];
  candidates: IntegerCandidate[];
  /** 连通分量标签：-1 = 阻断 */
  components: Int32Array;
}

interface Neighbor {
  u: [number, number];
  v: [number, number];
  horiz: boolean;
}

/**
 * 二维相位展开（质量引导的洪水 BFS 生成树 + 显式整周/循环记录）。
 *
 *  - 每个有效连通分量一棵生成树；低振幅/遮罩像素绝不参与（不猜相位）。
 *  - 每条树边记录 wrapK 与包裹梯度；每个像素保留从锚点出发的路径。
 *  - 非树边（弦）闭合为环路，计算循环残差（理想 0；切口附近 ±2pi*n）。
 *  - 切口两侧的整周偏移显式表示；无法唯一决定时给出全部合法 k 候选。
 */
export function unwrap(
  grid: GridGeometry,
  wrapped: number[],
  blocked: boolean[],
  cuts: CutEdge[],
  ids: {
    tree: (componentId: string) => string;
    edge: (u: [number, number], v: [number, number]) => string;
    path: (target: [number, number]) => string;
    cycle: (n: number) => string;
    candidate: (pixel: [number, number], reason: IntegerCandidate['ambiguityReason']) => string;
  },
): UnwrapResult {
  const { rows, cols } = grid;
  const N = rows * cols;
  const components = labelComponents(rows, cols, blocked);
  const numComponents =
    components.reduce((m, x) => (x >= 0 ? Math.max(m, x + 1) : m), 0) ?? 0;

  const trees: UnwrapTree[] = [];
  const candidates: IntegerCandidate[] = [];
  const idx = (r: number, c: number) => r * cols + c;
  const inBounds = (r: number, c: number) => r >= 0 && c >= 0 && r < rows && c < cols;

  for (let comp = 0; comp < numComponents; comp++) {
    const componentId = `comp-${comp}`;
    // 分量锚点：行优先第一个有效像素
    let anchor: [number, number] | null = null;
    for (let r = 0; r < rows && !anchor; r++)
      for (let c = 0; c < cols; c++)
        if (components[idx(r, c)] === comp) {
          anchor = [r, c];
          break;
        }
    if (!anchor) continue;

    const treeEdges: TreeEdge[] = [];
    const edgeSet = new Set<string>();
    // parent 记录每个像素来自的树边
    const parentEdge = new Map<number, string>();
    const parentNode = new Map<number, number>();
    const kAt = new Map<number, number>();
    const visited = new Set<number>();

    const queue: number[] = [idx(anchor[0], anchor[1])];
    visited.add(queue[0]);
    kAt.set(queue[0], 0);

    const four = (r: number, c: number): Neighbor[] => {
      const out: Neighbor[] = [];
      const deltas: Array<[number, number]> = [
        [0, 1],
        [1, 0],
        [0, -1],
        [-1, 0],
      ];
      for (const [dr, dc] of deltas) {
        const nr = r + dr;
        const nc = c + dc;
        if (inBounds(nr, nc)) out.push({ u: [r, c], v: [nr, nc], horiz: dc !== 0 });
      }
      return out;
    };

    while (queue.length) {
      const pi = queue.shift()!;
      const pr = Math.floor(pi / cols);
      const pc = pi % cols;
      for (const n of four(pr, pc)) {
        const ni = idx(n.v[0], n.v[1]);
        if (components[ni] !== comp) continue; // 跨分量（孔洞）：不连
        if (cutBlocksEdge(cuts, n.u, n.v)) continue; // 切口：树不穿越
        if (visited.has(ni)) continue;
        const delta = wrap(wrapped[ni] - wrapped[pi]);
        const k = Math.round((wrapped[pi] + (kAt.get(pi) ?? 0) * TWO_PI + delta - wrapped[ni]) / TWO_PI);
        visited.add(ni);
        kAt.set(ni, k);
        const edgeId = ids.edge(n.u, n.v);
        edgeSet.add(edgeKey(n.u, n.v));
        treeEdges.push({
          edgeId: ids.edge(n.u, n.v),
          from: n.u,
          to: n.v,
          wrapK: k,
          wrappedGradRad: delta,
          blocked: false,
        });
        parentEdge.set(ni, edgeId);
        parentNode.set(ni, pi);
        queue.push(ni);
      }
    }

    // 从锚点重建每条路径（稳定、可复查）
    const paths: UnwrapPath[] = [];
    const pixelOut: UnwrappedPixel[] = Array.from({ length: N }, (): UnwrappedPixel => ({
      status: "unknown",
      reason: "invalid-mask",
    }));

    const pathToRoot = (node: number): { edgeIds: string[]; cumulativeK: number } => {
      const edgeIds: string[] = [];
      let cur = node;
      let cumulativeK = 0;
      while (parentNode.has(cur)) {
        const eid = parentEdge.get(cur)!;
        edgeIds.push(eid);
        cumulativeK += kAt.get(cur) ?? 0;
        cur = parentNode.get(cur)!;
      }
      edgeIds.reverse();
      return { edgeIds, cumulativeK };
    };

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = idx(r, c);
        if (blocked[i]) {
          pixelOut[i] = {
            status: 'unknown',
            reason: blockedReasonAt(components, i),
          };
          continue;
        }
        if (components[i] !== comp) {
          pixelOut[i] = { status: 'unknown', reason: 'isolated' };
          continue;
        }
        if (!visited.has(i)) {
          pixelOut[i] = { status: 'unknown', reason: 'isolated' };
          continue;
        }
        const path = pathToRoot(i);
        const k = kAt.get(i) ?? 0;
        paths.push({ target: [r, c], edgeIds: path.edgeIds, cumulativeK: path.cumulativeK });
        pixelOut[i] = {
          status: 'valid',
          unwrappedRad: wrapped[i] + k * TWO_PI,
          wrapK: k,
          pathEdgeIds: path.edgeIds,
        };
      }
    }

    // 非树边形成环路：对每条被访问过、但不在树中的有效邻接边计算循环残差
    const cycles: CycleResidual[] = [];
    const cutOffsets: UnwrapTree['cutOffsets'] = [];
    let cycleNo = 0;
    const seenChord = new Set<string>();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = idx(r, c);
        if (!visited.has(i)) continue;
        for (const n of four(r, c)) {
          const j = idx(n.v[0], n.v[1]);
          if (!inBounds(n.v[0], n.v[1]) || !visited.has(j)) continue;
          const ek = edgeKey(n.u, n.v);
          if (edgeSet.has(ek)) continue;
          if (seenChord.has(ek)) continue;
          const cutId = cutBlocksEdge(cuts, n.u, n.v);
          if (cutId) {
            // 切口两侧整周偏移：显式但通常不唯一
            const implied = relativeOffset(kAt.get(i) ?? 0, kAt.get(j) ?? 0, wrapped[i], wrapped[j]);
            const kOptions = legalCutKOptions(implied);
            cutOffsets.push({
              edgeId: cutId,
              offsetCycles: kOptions.length === 1 ? kOptions[0] : null,
            });
            candidates.push({
              candidateId: ids.candidate(n.v, 'cut-crossing'),
              pixel: n.v,
              kOptions,
              acceptedK: null,
              ambiguityReason: 'cut-crossing',
            });
            continue;
          }
          seenChord.add(ek);
          const pi = pathToRoot(i);
          const pj = pathToRoot(j);
          const cycleEdgeIds = dedupeCycle([...pi.edgeIds, ids.edge(n.u, n.v), ...pj.edgeIds.slice().reverse()]);
          const grad = wrap(wrapped[j] - wrapped[i]);
          // 环路积分 = 沿两条树路径的 unwrapped 差 + 弦包裹梯度
          const residualRad = wrap(
            wrapped[j] + (kAt.get(j) ?? 0) * TWO_PI - (wrapped[i] + (kAt.get(i) ?? 0) * TWO_PI) - grad,
          );
          const integerCycles = Math.round(residualRad / TWO_PI);
          cycles.push({
            cycleId: ids.cycle(cycleNo++),
            edgeIds: cycleEdgeIds,
            residualRad: integerCycles * TWO_PI,
            integerCycles,
            closed: integerCycles === 0,
          });
          if (integerCycles !== 0) {
            candidates.push({
              candidateId: ids.candidate(n.v, 'cycle-mismatch'),
              pixel: n.v,
              kOptions: legalCutKOptions(kAt.get(j) ?? 0),
              acceptedK: null,
              ambiguityReason: 'cycle-mismatch',
            });
          }
        }
      }
    }

    trees.push({
      treeId: ids.tree(componentId),
      componentId,
      anchor,
      edges: treeEdges,
      paths,
      cycles,
      pixels: { values: pixelOut },
      cutOffsets,
    });
  }

  // 多连通分量：相对锚点整周未知 -> 多分量锚点候选（第 2 个分量起）
  for (let comp = 1; comp < numComponents; comp++) {
    const first = trees[comp]?.anchor;
    if (first) {
      candidates.push({
        candidateId: ids.candidate(first, 'multi-component-anchor'),
        pixel: first,
        kOptions: [-1, 0, 1],
        acceptedK: null,
        ambiguityReason: 'multi-component-anchor',
      });
    }
  }

  return { trees, candidates, components };
}

function blockedReasonAt(components: Int32Array, i: number): 'invalid-mask' | 'low-amplitude' | 'isolated' {
  return components[i] < 0 ? 'invalid-mask' : 'isolated';
}

function edgeKey(a: [number, number], b: [number, number]): string {
  return [a, b].map((p) => p.join(',')).sort().join('|');
}

function relativeOffset(ki: number, kj: number, wi: number, wj: number): number {
  // 沿 i->j 包裹梯度推断 j 相对 i 的整周
  return Math.round((wi + ki * TWO_PI + wrap(wj - wi) - (wj + kj * TWO_PI)) / TWO_PI) + kj - ki;
}

/** 局部都连续的合法整周：以测量值为中心给出 {-1,0,+1}（真实切口无法唯一） */
function legalCutKOptions(center: number): number[] {
  return [center - 1, center, center + 1].sort((a, b) => a - b);
}

function dedupeCycle(edgeIds: string[]): string[] {
  // 路径公共前缀会成对出现，去除相互抵消的重复边
  const counts = new Map<string, number>();
  for (const e of edgeIds) counts.set(e, (counts.get(e) ?? 0) + 1);
  return edgeIds.filter((e) => (counts.get(e) ?? 0) % 2 === 1);
}

/** 4 邻域连通分量（阻断像素标 -1，区分遮罩与低振幅由调用方在 blocked 决定） */
export function labelComponents(rows: number, cols: number, blocked: boolean[]): Int32Array {
  const labels = new Int32Array(rows * cols).fill(-1);
  const idx = (r: number, c: number) => r * cols + c;
  let next = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const start = idx(r, c);
      if (blocked[start] || labels[start] !== -1) continue;
      const label = next++;
      const stack = [start];
      labels[start] = label;
      while (stack.length) {
        const i = stack.pop()!;
        const cr = Math.floor(i / cols);
        const cc = i % cols;
        const neigh: Array<[number, number]> = [
          [cr, cc + 1],
          [cr, cc - 1],
          [cr + 1, cc],
          [cr - 1, cc],
        ];
        for (const [nr, nc] of neigh) {
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          const ni = idx(nr, nc);
          if (!blocked[ni] && labels[ni] === -1) {
            labels[ni] = label;
            stack.push(ni);
          }
        }
      }
    }
  }
  return labels;
}
