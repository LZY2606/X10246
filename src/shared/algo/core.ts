import type {
  Artifact, ArtifactRef, CutEdge, CycleResult, HeightMapCell, HeightMapPayload,
  ResidueCell, ResidueMapPayload, UnwrapCandidatePayload, UnwrapTreeNode
} from '../../shared/types';

export const ALGORITHM_VERSION = 'unwrap-quality-guided-v1.3';
export const TWO_PI = Math.PI * 2;

export interface AnalysisParams {
  amplitudeHoldThreshold: number;
  snrHoldThresholdDb: number;
  maxCandidates: number;
  cycleCloseToleranceRad: number;
  normalIncidenceFactor: number;
}

export const DEFAULT_PARAMS: AnalysisParams = {
  amplitudeHoldThreshold: 0.2,
  snrHoldThresholdDb: 3,
  maxCandidates: 4,
  cycleCloseToleranceRad: 1e-3,
  normalIncidenceFactor: 2
};

export interface InputSnapshot {
  wrapped: Artifact;
  amplitude: Artifact;
  quality: Artifact;
  mask: Artifact;
  wavelength: Artifact;
  geometry: Artifact;
  calibration: Artifact;
  cutHistory?: Artifact;
}

export const idx = (r: number, c: number, cols: number): number => r * cols + c;

export function wrap(x: number): number {
  let y = x % TWO_PI;
  if (y > Math.PI) y -= TWO_PI;
  if (y < -Math.PI) y += TWO_PI;
  return y;
}

export function refOf(a: Artifact): ArtifactRef {
  return { kind: a.kind, id: a.id, version: a.version, summary: a.summary };
}

export type HoldReason = 'border' | 'masked' | 'amplitude_missing' | 'low_amplitude' | 'low_snr';

export function pixelHeld(snap: InputSnapshot, p: AnalysisParams, r: number, c: number): { held: boolean; reason?: HoldReason } {
  const cols = snap.wrapped.frame!.cols;
  const rows = snap.wrapped.frame!.rows;
  if (r < 0 || c < 0 || r >= rows || c >= cols) return { held: true, reason: 'border' };
  if (snap.mask.frame!.values[idx(r, c, cols)] === 1) return { held: true, reason: 'masked' };
  const amp = snap.amplitude.frame!.values[idx(r, c, cols)];
  if (amp === null) return { held: true, reason: 'amplitude_missing' };
  if (amp < p.amplitudeHoldThreshold) return { held: true, reason: 'low_amplitude' };
  const snr = snap.quality.frame!.values[idx(r, c, cols)];
  if (snr !== null && snr < p.snrHoldThresholdDb) return { held: true, reason: 'low_snr' };
  return { held: false };
}

export interface ScenarioFlags {
  phaseWrapBoundary: boolean;
  lowAmplitudeHole: boolean;
  multiConnected: boolean;
  cycleNotClosed: boolean;
  wavelengthVersionChanged: boolean;
  integerAmbiguity: boolean;
  lockConflict: boolean;
}

// ---------- 1) 残差图：2x2 回路包裹相位和 → ±2π 残差点 ----------
export function computeResidues(snap: InputSnapshot, p: AnalysisParams): ResidueMapPayload {
  const { rows, cols, values } = snap.wrapped.frame!;
  const cells: ResidueCell[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const corners = [[r, c], [r, c + 1], [r + 1, c + 1], [r + 1, c]] as [number, number][];
      const unknown = corners.some(([rr, cc]) => pixelHeld(snap, p, rr, cc).held);
      if (unknown) {
        cells.push({ row: r, col: c, charge: 0, unknown: true, wrappedSumRad: null, sources: sourceVersions(snap, corners) });
        continue;
      }
      let sum = 0;
      for (let i = 0; i < 4; i++) {
        const [r1, c1] = corners[i];
        const [r2, c2] = corners[(i + 1) % 4];
        sum += wrap(values[idx(r2, c2, cols)]! - values[idx(r1, c1, cols)]!);
      }
      const charge = sum > Math.PI / 2 ? 1 : sum < -Math.PI / 2 ? -1 : 0;
      cells.push({ row: r, col: c, charge, wrappedSumRad: sum, sources: sourceVersions(snap, corners) });
    }
  }
  return { rows, cols, cells };
}

function sourceVersions(snap: InputSnapshot, corners: [number, number][]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of [snap.wrapped, snap.amplitude, snap.quality, snap.mask]) {
    out[a.id] = a.version;
  }
  void corners;
  return out;
}

// ---------- 2) 支路切口：正负残差配对接驳，未配对者接边界 ----------
export function buildCutNetwork(
  snap: InputSnapshot,
  residue: ResidueMapPayload,
  explicitPins: Map<string, number>,
  editedCuts: { edge: [[number, number], [number, number]]; offset: number | null }[]
): { edges: CutEdge[]; pairing: { plus: [number, number]; minus: [number, number]; reason: string }[]; boundaryCuts: [[number, number], [number, number]][]; scenarios: ScenarioFlags } {
  const plus = residue.cells.filter((c) => c.charge === 1).map((c) => [c.row, c.col] as [number, number]);
  const minus = residue.cells.filter((c) => c.charge === -1).map((c) => [c.row, c.col] as [number, number]);
  const usedMinus = new Set<number>();
  const edges: CutEdge[] = [];
  const pairing: { plus: [number, number]; minus: [number, number]; reason: string }[] = [];
  const boundaryCuts: [[number, number], [number, number]][] = [];

  plus.forEach((pp) => {
    let best = -1;
    let bestDist = Infinity;
    minus.forEach((mm, mi) => {
      if (usedMinus.has(mi)) return;
      const d = Math.abs(pp[0] - mm[0]) + Math.abs(pp[1] - mm[1]);
      if (d < bestDist) { bestDist = d; best = mi; }
    });
    if (best >= 0) {
      usedMinus.add(best);
      pairing.push({ plus: pp, minus: minus[best], reason: 'nearest_opposite_charge' });
      addCutEdges(edges, pp, minus[best], explicitPins);
    } else {
      const target: [number, number] = [Math.min(snap.wrapped.frame!.rows - 1, pp[0] + 1), pp[1]];
      boundaryCuts.push([pp, target]);
      addCutEdges(edges, pp, target, explicitPins);
    }
  });
  minus.forEach((mm, mi) => {
    if (usedMinus.has(mi)) return;
    const target: [number, number] = [0, mm[1]];
    boundaryCuts.push([mm, target]);
    addCutEdges(edges, mm, target, explicitPins);
  });

  for (const ec of editedCuts) {
    addCutEdges(edges, ec.edge[0], ec.edge[1], explicitPins, ec.offset);
  }

  // 去重（按无向边键）
  const dedup = new Map<string, CutEdge>();
  for (const e of edges) {
    const key = edgeKey(e.a, e.b);
    if (!dedup.has(key)) dedup.set(key, e);
    else {
      const existing = dedup.get(key)!;
      if (e.integerOffset !== null) existing.integerOffset = e.integerOffset;
      if (e.pinned) existing.pinned = true;
    }
  }
  const scenarios: ScenarioFlags = {
    phaseWrapBoundary: false,
    lowAmplitudeHole: false,
    multiConnected: false,
    cycleNotClosed: pairing.length > 0 || boundaryCuts.length > 0,
    wavelengthVersionChanged: false,
    integerAmbiguity: false,
    lockConflict: false
  };
  return { edges: [...dedup.values()], pairing, boundaryCuts, scenarios };
}

export function edgeKey(a: [number, number], b: [number, number]): string {
  const ka = `${a[0]},${a[1]}`;
  const kb = `${b[0]},${b[1]}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function addCutEdges(
  edges: CutEdge[], a0: [number, number], b0: [number, number],
  pins: Map<string, number>, editedOffset?: number | null
): void {
  // L 型支路：先竖直后水平
  let a = a0;
  const steps: [number, number][] = [];
  if (a0[0] !== b0[0]) steps.push([Math.sign(b0[0] - a0[0]), 0]);
  if (a0[1] !== b0[1]) steps.push([0, Math.sign(b0[1] - a0[1])]);
  for (const [dr, dc] of steps) {
    const b: [number, number] = [a[0] + dr, a[1] + dc];
    const key = edgeKey(a, b);
    const pinned = pins.has(key);
    const integerOffset = editedOffset !== undefined && editedOffset !== null ? editedOffset
      : pinned ? pins.get(key)! : null;
    edges.push({
      id: 'cut_' + key.replace(/[|,]/g, '_'),
      a, b,
      integerOffset,
      pinned,
      ...(integerOffset !== null ? { rejectedOffsets: [-1, 0, 1].filter((k) => k !== integerOffset).map((offset) => ({ offset, reason: pinned ? 'pinned_by_operator' : 'alternate_offset' })) } : {})
    });
    a = b;
  }
}
