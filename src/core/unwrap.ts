import type { BranchCutNetwork, CutEdge } from './branchcuts.js';
import type { RegionResult } from './regions.js';
import type { Grid } from './grid.js';
import { edgeId, idx, wrappedDiff } from './grid.js';

export interface CycleResidual {
  loopId: string;
  /** Top-left pixel of the 2x2 loop. */
  r: number;
  c: number;
  /** Sum of wrapped differences around the loop, in radians. */
  residualRad: number;
  /** Signed whole-cycle discrepancy (0 closes; +/-1 is a residue). */
  cycles: number;
  /** Fraction-of-cycle residual after removing whole cycles. */
  fraction: number;
}

export interface TreePathEntry {
  pixel: string;
  region: number;
  /** Tree edge from parent; null at the root. */
  parentEdge: string | null;
  /** Wrapped difference accumulated on the parent edge. */
  edgeDeltaRad: number | null;
}

export interface RegionUnwrap {
  regionId: number;
  root: string;
  unwrapped: Map<number, number>;
  /** Ordered pixel ids on the spanning tree path. */
  treePath: string[];
  pathDetail: TreePathEntry[];
  /** Cycles crossed on each tree edge (boundary crossing evidence). */
  edgeCycles: Record<string, number>;
  cycles: CycleResidual[];
  /** Max |fraction| residual among loops touching this region. */
  maxFraction: number;
}

export interface UnwrapResult {
  regions: RegionUnwrap[];
  /**
   * Per-region global whole-cycle ambiguity. Wrapped data fixes relative
   * phase but the absolute 2*pi*k of a region is only known up to a set of
   * legal integers: when >1 candidate exists the result is multi-valued.
   */
  regionOffsets: Array<{ regionId: number; legalOffsets: number[] }>;
  /** Cut edges whose integer offset cannot be uniquely determined. */
  ambiguousCuts: CutEdge[];
  /** True when at least one loop fails to close. */
  hasNonClosingCycle: boolean;
}

/**
 * Quality-guided flood fill. Cuts are never crossed by the tree; pixels
 * separated by cuts live in independent regions and keep an explicit whole
 * cycle offset (or the full candidate set when it is not unique).
 */
export function unwrapRegions(
  phase: Grid,
  quality: Float64Array,
  regions: RegionResult,
  network: BranchCutNetwork,
  charge: Int8Array,
  params: { maxLegalOffset: number }
): UnwrapResult {
  const { rows, cols } = phase;
  const results: RegionUnwrap[] = [];

  for (let regionId = 0; regionId < regions.regionCount; regionId += 1) {
    let root = -1;
    let bestQ = -1;
    for (let i = 0; i < regions.regionOf.length; i += 1) {
      if (regions.regionOf[i] === regionId && quality[i]! > bestQ) {
        bestQ = quality[i]!;
        root = i;
      }
    }
    const unwrapped = new Map<number, number>();
    const treePath: string[] = [];
    const pathDetail: TreePathEntry[] = [];
    const edgeCycles: Record<string, number> = {};
    // Priority flood fill: expand the highest-quality frontier edge first.
    const frontier = new Set<number>([root]);
    unwrapped.set(root, phase.values[root]!);
    while (frontier.size) {
      let next = -1;
      let nextQ = -1;
      for (const p of frontier) {
        if (quality[p]! > nextQ) {
          nextQ = quality[p]!;
          next = p;
        }
      }
      frontier.delete(next);
      treePath.push(pixelIdOf(next, cols));
      const r = Math.floor(next / cols);
      const c = next % cols;
      const neighborList = [
        [r, c - 1],
        [r, c + 1],
        [r - 1, c],
        [r + 1, c]
      ];
      for (const [nr, nc] of neighborList) {
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
        const q = idx(rows, cols, nr, nc);
        if (regions.regionOf[q] !== regionId || unwrapped.has(q) || frontier.has(q)) continue;
        if (isCutBetween(network, r, c, nr, nc)) continue;
        const delta = wrappedDiff(phase.values[q]!, phase.values[next]!);
        unwrapped.set(q, unwrapped.get(next)! + delta);
        const eid = canonicalEdgeId(r, c, nr, nc);
        edgeCycles[eid] = Math.round(((phase.values[q]! - phase.values[next]!) - delta) / (2 * Math.PI));
        pathDetail.push({
          pixel: pixelIdOf(q, cols),
          region: regionId,
          parentEdge: eid,
          edgeDeltaRad: delta
        });
        frontier.add(q);
      }
    }
    pathDetail.unshift({
      pixel: pixelIdOf(root, cols),
      region: regionId,
      parentEdge: null,
      edgeDeltaRad: null
    });

    const cycles = loopResiduals(phase, charge, regions, regionId);
    let maxFraction = 0;
    for (const loop of cycles) maxFraction = Math.max(maxFraction, Math.abs(loop.fraction));
    results.push({
      regionId,
      root: pixelIdOf(root, cols),
      unwrapped,
      treePath,
      pathDetail,
      edgeCycles,
      cycles,
      maxFraction
    });
  }

  const regionOffsets = results.map((result, index) => {
    const nonClosing = result.cycles.some((loop) => loop.cycles !== 0);
    if (nonClosing || network.unpairedResidues.length > 0 || regions.multiConnected) {
      const span = params.maxLegalOffset;
      const legalOffsets: number[] = [];
      for (let k = -span; k <= span; k += 1) legalOffsets.push(k);
      return { regionId: index, legalOffsets };
    }
    return { regionId: index, legalOffsets: [0] };
  });

  const ambiguousCuts: CutEdge[] = [];
  for (const edge of network.edges) {
    if (edge.offsetCycles === null) {
      if (edge.source === 'unknown_loop') {
        edge.legalOffsets = [-1, 0, 1];
        ambiguousCuts.push(edge);
      } else if (edge.source === 'residue_pair' && (edge.residueCharge ?? 0) !== 0) {
        edge.offsetCycles = edge.residueCharge ?? null;
        edge.legalOffsets = [edge.offsetCycles ?? 0];
      } else {
        edge.legalOffsets = [0];
        edge.offsetCycles = 0;
      }
    } else {
      edge.legalOffsets = [edge.offsetCycles];
    }
  }

  return {
    regions: results,
    regionOffsets,
    ambiguousCuts,
    hasNonClosingCycle: results.some((r) => r.cycles.some((loop) => loop.cycles !== 0))
  };
}

function loopResiduals(
  phase: Grid,
  charge: Int8Array,
  regions: RegionResult,
  regionId: number
): CycleResidual[] {
  const { rows, cols } = phase;
  const out: CycleResidual[] = [];
  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < cols - 1; c += 1) {
      const a = idx(rows, cols, r, c);
      const b = idx(rows, cols, r, c + 1);
      const d = idx(rows, cols, r + 1, c + 1);
      const e = idx(rows, cols, r + 1, c);
      if (![a, b, d, e].every((p) => regions.regionOf[p] === regionId)) continue;
      const sum =
        wrappedDiff(phase.values[b]!, phase.values[a]!) +
        wrappedDiff(phase.values[d]!, phase.values[b]!) +
        wrappedDiff(phase.values[e]!, phase.values[d]!) +
        wrappedDiff(phase.values[a]!, phase.values[e]!);
      const cycles = charge[r * (cols - 1) + c]!;
      out.push({
        loopId: `loop:${r},${c}`,
        r,
        c,
        residualRad: sum,
        cycles,
        fraction: sum / (2 * Math.PI) - cycles
      });
    }
  }
  return out;
}

function isCutBetween(network: BranchCutNetwork, r1: number, c1: number, r2: number, c2: number): boolean {
  const [ar, ac, br, bc] = canonical(r1, c1, r2, c2);
  return network.edgeIndex.has(edgeId(ar, ac, br, bc));
}

function canonical(r1: number, c1: number, r2: number, c2: number): [number, number, number, number] {
  const a = r1 * 1_000_000 + c1;
  const b = r2 * 1_000_000 + c2;
  return a <= b ? [r1, c1, r2, c2] : [r2, c2, r1, c1];
}

function canonicalEdgeId(r1: number, c1: number, r2: number, c2: number): string {
  const [ar, ac, br, bc] = canonical(r1, c1, r2, c2);
  return edgeId(ar, ac, br, bc);
}

function pixelIdOf(index: number, cols: number): string {
  return `${Math.floor(index / cols)},${index % cols}`;
}
