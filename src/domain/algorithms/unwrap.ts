import { Grid } from "../grid.js";
import { principalDelta, TWO_PI } from "../wrapmath.js";
import type {
  CycleOrderCandidate,
  CutEdge,
  TreeEdge
} from "../entities.js";

export interface UnwrapInput {
  wrappedRadians: number[];
  usable: boolean[];
  blockedPairs: ReadonlySet<string>;
  cutEdges: CutEdge[];
  quality: number[];
}

export interface RegionUnwrap {
  region: number;
  seedIndex: number;
  memberIndices: number[];
  edges: TreeEdge[];
  unwrappedRadians: number[];
  unknownIndices: number[];
  cutOrderDeltas: Array<{ edge: [number, number]; delta: number }>;
  candidates: CycleOrderCandidate[];
}

export interface UnwrapAllResult {
  regions: RegionUnwrap[];
}

const pairKey = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;

function buildRegions(grid: Grid, input: UnwrapInput): number[] {
  const region = new Array<number>(grid.size).fill(-1);
  let count = 0;
  const blocked = input.blockedPairs;
  for (let start = 0; start < grid.size; start++) {
    if (!input.usable[start] || region[start] !== -1) continue;
    const id = count++;
    const stack = [start];
    region[start] = id;
    while (stack.length) {
      const cur = stack.pop()!;
      for (const n of grid.neighbors(cur)) {
        if (input.usable[n.index] && region[n.index] === -1 && !blocked.has(pairKey(cur, n.index))) {
          region[n.index] = id;
          stack.push(n.index);
        }
      }
    }
  }
  return region;
}

function finalize(
  grid: Grid,
  input: UnwrapInput,
  region: number[],
  strategy: "quality_flood" | "shortest_jump_mst"
): RegionUnwrap[] {
  const regionIds = [...new Set(region)].filter((r) => r >= 0).sort((a, b) => a - b);
  const out: RegionUnwrap[] = [];
  for (const rid of regionIds) {
    const members: number[] = [];
    for (let i = 0; i < grid.size; i++) if (region[i] === rid) members.push(i);
    let edges: TreeEdge[];
    let seedIndex: number;
    if (strategy === "quality_flood") {
      const seed = members.reduce((best, i) => (input.quality[i]! > input.quality[best]! ? i : best), members[0]!);
      const chosen = qualityFlood(grid, input, members, seed);
      edges = chosen.edges;
      seedIndex = seed;
    } else {
      const seed = members.reduce((best, i) => {
        const { col, row } = grid.coord(i);
        const d = col + row;
        const bd = grid.coord(best);
        return d < bd.col + bd.row ? i : best;
      }, members[0]!);
      edges = shortestJumpMst(grid, input, members, seed);
      seedIndex = seed;
    }

    const unwrapped = new Array<number>(grid.size).fill(NaN);
    const unknown: number[] = [];
    const parent = new Map<number, number>();
    for (const e of edges) {
      parent.set(e.to, e.from);
    }
    unwrapped[seedIndex] = input.wrappedRadians[seedIndex]!;
    for (const e of edges) {
      unwrapped[e.to] = unwrapped[e.from]! + e.wrapIncrement;
    }
    for (let i = 0; i < grid.size; i++) {
      if (region[i] === -1) unknown.push(i);
    }

    const cutOrderDeltas: Array<{ edge: [number, number]; delta: number }> = [];
    const candidates: CycleOrderCandidate[] = [];
    const seenCutPairs = new Set<string>();
    for (const ce of input.cutEdges) {
      if (ce.kind !== "residue_pair") continue;
      const key = pairKey(ce.a, ce.b);
      if (seenCutPairs.has(key)) continue;
      seenCutPairs.add(key);
      const delta = NaN;
      cutOrderDeltas.push({ edge: [ce.a, ce.b], delta });
      [-1, 0, 1].forEach((k) => {
        candidates.push({
          candidateId: `cand_${ce.a}_${ce.b}_k${k >= 0 ? "p" : "m"}${Math.abs(k)}`,
          orderOffsets: [k],
          scorePenalty: Math.abs(k) * 2 + (k === 0 ? 0.6 : 0),
          status: "legal",
          rejectionReason: null,
          cutSideDelta: k
        });
      });
      [2, -2].forEach((k) => {
        candidates.push({
          candidateId: `cand_${ce.a}_${ce.b}_k${k > 0 ? "p" : "m"}2`,
          orderOffsets: [k],
          scorePenalty: 99,
          status: "rejected",
          rejectionReason: "offset |k|=2 implies a 4pi discontinuity across one cut; incompatible with smooth surface prior",
          cutSideDelta: k
        });
      });
    }

    out.push({
      region: rid,
      seedIndex,
      memberIndices: members,
      edges,
      unwrappedRadians: unwrapped,
      unknownIndices: unknown,
      cutOrderDeltas,
      candidates
    });
  }
  return out;
}

function qualityFlood(grid: Grid, input: UnwrapInput, members: number[], seed: number): { edges: TreeEdge[] } {
  const memberSet = new Set(members);
  const reached = new Set<number>([seed]);
  const edges: TreeEdge[] = [];
  const frontier: Array<{ from: number; to: number; k: number; q: number }> = [];
  const pushNeighbors = (from: number) => {
    for (const n of grid.neighbors(from)) {
      if (!memberSet.has(n.to ?? n.index)) continue;
      const idx = n.index;
      if (reached.has(idx) || input.blockedPairs.has(pairKey(from, idx))) continue;
      const k = Math.round((0 - principalDelta(input.wrappedRadians[idx]!, input.wrappedRadians[from]!)) / TWO_PI);
      void k;
    }
  };
  void pushNeighbors;

  const heap: Array<{ from: number; to: number; q: number }> = [];
  const pop = () => {
    let bestIdx = 0;
    for (let i = 1; i < heap.length; i++) if (heap[i]!.q > heap[bestIdx]!.q) bestIdx = i;
    return heap.splice(bestIdx, 1)[0]!;
  };
  const addFrontier = (from: number) => {
    for (const n of grid.neighbors(from)) {
      const idx = n.index;
      if (!memberSet.has(idx) || reached.has(idx) || input.blockedPairs.has(pairKey(from, idx))) continue;
      if (heap.some((h) => h.to === idx)) continue;
      heap.push({ from, to: idx, q: input.quality[idx]! });
    }
  };
  addFrontier(seed);
  const cutCrossedMark = new Set<string>();
  while (heap.length) {
    const next = pop();
    if (reached.has(next.to)) continue;
    const delta = principalDelta(input.wrappedRadians[next.to]!, input.wrappedRadians[next.from]!);
    const k = Math.round((0 - delta) / TWO_PI);
    void k;
    const increment = delta;
    const crossed = input.cutEdges.some((ce) => pairKey(ce.a, ce.b) === pairKey(next.from, next.to));
    if (crossed) cutCrossedMark.add(pairKey(next.from, next.to));
    reached.add(next.to);
    edges.push({
      from: next.from,
      to: next.to,
      wrapIncrement: increment,
      cutCrossed: crossed,
      cutEdge: crossed ? [Math.min(next.from, next.to), Math.max(next.from, next.to)] : undefined
    });
    addFrontier(next.to);
  }
  return { edges };
}

function shortestJumpMst(grid: Grid, input: UnwrapInput, members: number[], seed: number): TreeEdge[] {
  const memberSet = new Set(members);
  const reached = new Set<number>([seed]);
  const edges: TreeEdge[] = [];
  const heap: Array<{ from: number; to: number; w: number }> = [];
  const add = (from: number) => {
    for (const n of grid.neighbors(from)) {
      const idx = n.index;
      if (!memberSet.has(idx) || reached.has(idx) || input.blockedPairs.has(pairKey(from, idx))) continue;
      if (heap.some((h) => h.to === idx)) continue;
      heap.push({ from, to: idx, w: Math.abs(principalDelta(input.wrappedRadians[idx]!, input.wrappedRadians[from]!)) });
    }
  };
  add(seed);
  while (heap.length) {
    let bi = 0;
    for (let i = 1; i < heap.length; i++) if (heap[i]!.w < heap[bi]!.w) bi = i;
    const next = heap.splice(bi, 1)[0]!;
    if (reached.has(next.to)) continue;
    const increment = principalDelta(input.wrappedRadians[next.to]!, input.wrappedRadians[next.from]!);
    const crossed = input.cutEdges.some((ce) => pairKey(ce.a, ce.b) === pairKey(next.from, next.to));
    reached.add(next.to);
    edges.push({
      from: next.from,
      to: next.to,
      wrapIncrement: increment,
      cutCrossed: crossed,
      cutEdge: crossed ? [Math.min(next.from, next.to), Math.max(next.from, next.to)] : undefined
    });
    add(next.to);
  }
  return edges;
}

export function unwrapAll(
  grid: Grid,
  input: UnwrapInput,
  strategy: "quality_flood" | "shortest_jump_mst"
): UnwrapAllResult {
  const region = buildRegions(grid, input);
  return { regions: finalize(grid, input, region, strategy) };
}
