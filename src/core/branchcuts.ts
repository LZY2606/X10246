import type { CutEdit } from './types.js';
import type { Grid } from './grid.js';
import { edgeId, idx } from './grid.js';

export interface CutEdge {
  id: string;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  /**
   * Explicit whole-cycle (2*pi) offset across the cut.
   * null = unresolved/multi-valued: the offset is NOT guessed.
   */
  offsetCycles: number | null;
  /** All legal offsets when the cut cannot be uniquely resolved. */
  legalOffsets: number[];
  source: 'residue_pair' | 'human' | 'unknown_loop';
  residueCharge?: number;
}

export interface BranchCutNetwork {
  edges: CutEdge[];
  edgeIndex: Map<string, CutEdge>;
  unpairedResidues: Array<{ r: number; c: number; charge: number }>;
}

/**
 * Greedy nearest-neighbour pairing of opposite 2x2-loop charges, placing cuts
 * along the pixel edges between them. Residues without a partner remain
 * unpaired (e.g. at borders/holes) and keep an unknown-loop cut whose integer
 * offset is left unresolved.
 */
export function buildBranchCuts(
  phase: Grid,
  charge: Int8Array,
  unknownLoops: Uint8Array,
  edits: CutEdit[],
  rng: { next(): number }
): BranchCutNetwork {
  const { rows, cols } = phase;
  const edgeIndex = new Map<string, CutEdge>();
  const positives: Array<{ r: number; c: number }> = [];
  const negatives: Array<{ r: number; c: number }> = [];
  const loopRows = rows - 1;
  const loopCols = cols - 1;
  for (let r = 0; r < loopRows; r += 1) {
    for (let c = 0; c < loopCols; c += 1) {
      const k = r * loopCols + c;
      if (charge[k]! > 0) positives.push({ r, c });
      if (charge[k]! < 0) negatives.push({ r, c });
    }
  }
  // Deterministic shuffle for stable tie-breaking with the fixed seed.
  const shuffledPos = shuffle(positives, rng);
  const shuffledNeg = negatives.slice();
  const usedNeg = new Set<number>();
  const unpaired: BranchCutNetwork['unpairedResidues'] = [];

  for (const pos of shuffledPos) {
    let best = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    shuffledNeg.forEach((neg, ni) => {
      if (usedNeg.has(ni)) return;
      const dist = Math.abs(pos.r - neg.r) + Math.abs(pos.c - neg.c);
      if (dist < bestDist || (dist === bestDist && rng.next() > 0.5)) {
        bestDist = dist;
        best = ni;
      }
    });
    if (best === -1) {
      unpaired.push({ r: pos.r, c: pos.c, charge: 1 });
      continue;
    }
    usedNeg.add(best);
    const neg = shuffledNeg[best]!;
    placeCut(edgeIndex, pos, neg, cols, 1);
  }
  shuffledNeg.forEach((neg, ni) => {
    if (!usedNeg.has(ni)) unpaired.push({ r: neg.r, c: neg.c, charge: -1 });
  });

  // Unknown loops touch a low-amplitude/invalid pixel: boundary cut, unresolved.
  for (let r = 0; r < loopRows; r += 1) {
    for (let c = 0; c < loopCols; c += 1) {
      const k = r * loopCols + c;
      if (unknownLoops[k]) {
        ensureEdge(edgeIndex, r, c, r, c + 1, 'unknown_loop');
      }
    }
  }

  for (const edit of edits) {
    applyEdit(edgeIndex, edit);
  }

  return { edges: [...edgeIndex.values()], edgeIndex, unpairedResidues: unpaired };
}

function shuffle<T>(items: T[], rng: { next(): number }): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng.next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function placeCut(
  edgeIndex: Map<string, CutEdge>,
  from: { r: number; c: number },
  to: { r: number; c: number },
  cols: number,
  charge: number
): void {
  let r = from.r;
  let c = from.c;
  let guard = 0;
  while ((r !== to.r || c !== to.c) && guard < 10000) {
    guard += 1;
    if (r !== to.r) {
      ensureEdge(edgeIndex, r, c, r + 1, c, 'residue_pair', charge);
      r += Math.sign(to.r - r);
    } else {
      ensureEdge(edgeIndex, r, c, r, c + 1, 'residue_pair', charge);
      c += Math.sign(to.c - c);
    }
  }
  void cols;
  void idx;
}

function canonical(r1: number, c1: number, r2: number, c2: number): [number, number, number, number] {
  const a = r1 * 1_000_000 + c1;
  const b = r2 * 1_000_000 + c2;
  return a <= b ? [r1, c1, r2, c2] : [r2, c2, r1, c1];
}

function ensureEdge(
  edgeIndex: Map<string, CutEdge>,
  r1: number,
  c1: number,
  r2: number,
  c2: number,
  source: CutEdge['source'],
  charge?: number
): CutEdge {
  const [ar, ac, br, bc] = canonical(r1, c1, r2, c2);
  const id = edgeId(ar, ac, br, bc);
  const existing = edgeIndex.get(id);
  if (existing) {
    if (charge !== undefined && existing.source === 'residue_pair') existing.residueCharge = charge;
    return existing;
  }
  const edge: CutEdge = {
    id,
    r1: ar,
    c1: ac,
    r2: br,
    c2: bc,
    offsetCycles: null,
    legalOffsets: [],
    source,
    residueCharge: charge
  };
  edgeIndex.set(id, edge);
  return edge;
}

function applyEdit(edgeIndex: Map<string, CutEdge>, edit: CutEdit): void {
  const parts = edit.edgeId.split('-');
  const [r1s, c1s] = parts[0]!.split(',').map(Number);
  const [r2s, c2s] = parts[1]!.split(',').map(Number);
  const [ar, ac, br, bc] = canonical(r1s!, c1s!, r2s!, c2s!);
  const id = edgeId(ar, ac, br, bc);
  if (edit.action === 'remove') {
    edgeIndex.delete(id);
    return;
  }
  const edge = ensureEdge(edgeIndex, ar, ac, br, bc, 'human');
  if (edit.action === 'force_offset') {
    edge.offsetCycles = edit.integerOffsetCycles ?? null;
    edge.legalOffsets = edit.integerOffsetCycles === undefined ? [] : [edit.integerOffsetCycles];
  }
}

export function isCut(network: BranchCutNetwork, r1: number, c1: number, r2: number, c2: number): boolean {
  const [ar, ac, br, bc] = canonical(r1, c1, r2, c2);
  return network.edgeIndex.has(edgeId(ar, ac, br, bc));
}
