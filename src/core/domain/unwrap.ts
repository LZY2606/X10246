import { ALGORITHM_VERSIONS } from "../../shared/constants.js";
import type {
  BranchCutNetworkPayload,
  CutEdge,
  CycleResidual,
  CycleResidualsPayload,
  HeightFieldPayload,
  TreePathStep,
  UnwrappedPhasePayload,
  UnwrappedPixel,
  UnwrappedTreePayload,
} from "../../shared/types.js";
import { idx, neighbors4 } from "./grid.js";
import { cutEdgeKey } from "./residues.js";

export interface UnwrapInputs {
  width: number;
  height: number;
  phase: (number | null)[];
  valid: boolean[]; // 非遮罩、非低振幅（低振幅一律视为不可展开）
  quality: Map<number, number>;
  network: BranchCutNetworkPayload;
  parameterFingerprint: string;
}

export interface ConnectedComponent {
  id: string;
  pixels: { x: number; y: number }[];
}

export function connectedComponents(w: number, h: number, valid: boolean[]): ConnectedComponent[] {
  const seen = new Array(w * h).fill(false);
  const comps: ConnectedComponent[] = [];
  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const start = idx(w, sx, sy);
      if (!valid[start] || seen[start]) continue;
      const pixels: { x: number; y: number }[] = [];
      const queue = [{ x: sx, y: sy }];
      seen[start] = true;
      while (queue.length) {
        const p = queue.shift() as { x: number; y: number };
        pixels.push(p);
        for (const n of neighbors4(p.x, p.y, w, h)) {
          const ni = idx(w, n.x, n.y);
          if (valid[ni] && !seen[ni]) {
            seen[ni] = true;
            queue.push(n);
          }
        }
      }
      const key = `${pixels[0].x}_${pixels[0].y}_${pixels.length}`;
      comps.push({ id: `comp_${key}`, pixels });
    }
  }
  return comps;
}

export interface BuiltTree {
  tree: UnwrappedTreePayload;
  /** 像素索引 -> 展开相位（rad） */
  unwrapped: Map<number, number>;
  order: Map<number, number>;
  parent: Map<number, number>;
}

/**
 * 以质量优先（贪心：从根开始，每次从边界选质量最高的邻居）构建展开树。
 * 支路切口边不可跨越；低振幅/遮罩像素不参与——禁止猜相位。
 */
export function buildUnwrapTree(input: UnwrapInputs, root: { x: number; y: number }, treeId: string): BuiltTree {
  const { width: w, height: h, phase, valid, quality, network } = input;
  const cutKeys = new Set(network.edges.map((e) => cutEdgeKey(e.a, e.b)));
  const paths: TreePathStep[] = [];
  const unwrapped = new Map<number, number>();
  const parent = new Map<number, number>();
  const rootI = idx(w, root.x, root.y);
  unwrapped.set(rootI, phase[rootI] as number);
  const visited = new Set<number>([rootI]);

  const frontier: { i: number; from: number; step: TreePathStep }[] = [];
  const pushNeighbors = (pi: number) => {
    const px = pi % w;
    const py = Math.floor(pi / w);
    for (const n of neighbors4(px, py, w, h)) {
      const ni = idx(w, n.x, n.y);
      if (visited.has(ni) || !valid[ni]) continue;
      if (cutKeys.has(cutEdgeKey({ x: px, y: py }, n))) continue;
      let d = (phase[ni] as number) - (phase[pi] as number);
      let jump = 0;
      while (d > Math.PI) {
        d -= Math.PI * 2;
        jump += 1;
      }
      while (d <= -Math.PI) {
        d += Math.PI * 2;
        jump -= 1;
      }
      const step: TreePathStep = {
        from: { x: px, y: py },
        to: { x: n.x, y: n.y },
        wrappedDelta: Math.round(d * 1e9) / 1e9,
        integerJump: jump,
        crossesCut: false,
      };
      frontier.push({ i: ni, from: pi, step });
    }
  };
  pushNeighbors(rootI);

  while (frontier.length) {
    let best = 0;
    for (let i = 1; i < frontier.length; i++) {
      if ((quality.get(frontier[i].i) ?? 0) > (quality.get(frontier[best].i) ?? 0)) best = i;
    }
    const { i, from, step } = frontier.splice(best, 1)[0];
    if (visited.has(i)) continue;
    visited.add(i);
    const base = unwrapped.get(from) as number;
    let d = step.wrappedDelta;
    if (step.integerJump !== 0) d += step.integerJump * Math.PI * 2;
    const val = base + d;
    unwrapped.set(i, Math.round(val * 1e9) / 1e9);
    parent.set(i, from);
    paths.push(step);
    pushNeighbors(i);
  }

  const order = new Map<number, number>();
  for (const [i, v] of unwrapped) {
    order.set(i, Math.round((v - (phase[i] as number)) / (Math.PI * 2)));
  }

  const covered = [...visited].map((i) => ({ x: i % w, y: Math.floor(i / w) }));
  const tree: UnwrappedTreePayload = {
    treeId,
    root,
    paths,
    covered,
    algorithmVersion: ALGORITHM_VERSIONS.unwrap,
    parameterFingerprint: input.parameterFingerprint,
  };
  return { tree, unwrapped, order, parent };
}

/**
 * 循环残差：沿相邻像素环（以每个非树边构成的基本环）积分。
 * 切口边若缺显式整周偏移 → open_cut_offset_missing（禁止猜）。
 */
export function computeCycleResiduals(
  input: UnwrapInputs,
  built: BuiltTree,
  pixelToComponent: Map<number, string>,
): CycleResidualsPayload {
  const { width: w, height: h, phase, valid, network } = input;
  const cutByKey = new Map<string, CutEdge>();
  for (const e of network.edges) cutByKey.set(cutEdgeKey(e.a, e.b), e);
  const cycles: CycleResidual[] = [];
  let seq = 0;

  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const corners = [
        { x, y },
        { x: x + 1, y },
        { x: x + 1, y: y + 1 },
        { x, y: y + 1 },
      ];
      const ids = corners.map((p) => idx(w, p.x, p.y));
      if (!ids.every((i) => valid[i])) continue;
      if (new Set(ids.map((i) => pixelToComponent.get(i))).size !== 1) continue;

      let rawSum = 0;
      let unknown = false;
      const related: string[] = [];
      for (let i = 0; i < 4; i++) {
        const a = corners[i];
        const b = corners[(i + 1) % 4];
        const cut = cutByKey.get(cutEdgeKey(a, b));
        if (cut) {
          related.push(cut.edgeId);
          if (cut.integerOffset === null) {
            unknown = true;
            continue;
          }
        }
        let d = (phase[idx(w, b.x, b.y)] as number) - (phase[idx(w, a.x, a.y)] as number);
        while (d > Math.PI) d -= Math.PI * 2;
        while (d <= -Math.PI) d += Math.PI * 2;
        rawSum += d + (cut ? (cut.integerOffset as number) * Math.PI * 2 : 0);
      }
      const residualTurns = Math.round((rawSum / (Math.PI * 2)) * 1e6) / 1e6;
      let closureState: CycleResidual["closureState"] = "closed";
      if (unknown) closureState = "open_cut_offset_missing";
      else if (Math.abs(residualTurns) > 1e-5) closureState = "nonzero_residual";
      cycles.push({
        cycleId: `cycle_${String(seq++).padStart(4, "0")}`,
        pixels: corners,
        residualTurns: unknown ? null : residualTurns,
        closureState,
        relatedCutEdgeIds: related,
      });
    }
  }
  return { cycles, algorithmVersion: ALGORITHM_VERSIONS.cycle };
}

export function assembleUnwrapped(
  w: number,
  h: number,
  phase: (number | null)[],
  valid: boolean[],
  invalidReasonFor: (x: number, y: number) => UnwrappedPixel["unknownReason"],
  built: BuiltTree,
  componentOf: Map<number, string>,
  parameterFingerprint: string,
): UnwrappedPhasePayload {
  const pixels: UnwrappedPixel[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(w, x, y);
      if (built.unwrapped.has(i)) {
        pixels.push({
          x,
          y,
          unwrappedRad: built.unwrapped.get(i) as number,
          integerOrder: built.order.get(i) as number,
          treeId: built.tree.treeId,
        });
      } else if (phase[i] === null || !valid[i]) {
        const reason = invalidReasonFor(x, y);
        pixels.push({ x, y, unwrappedRad: null, integerOrder: null, unknownReason: reason });
      }
    }
  }
  void componentOf;
  return {
    width: w,
    height: h,
    pixels,
    algorithmVersion: ALGORITHM_VERSIONS.unwrap,
    parameterFingerprint,
  };
}

export type { HeightFieldPayload };
