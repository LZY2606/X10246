import { stableHash, stableId } from './identity.ts';
import type {
  CutEdit,
  CycleResidual,
  HeightValue,
  InterferometryFrameInput,
  PhaseGraphEdge,
  PixelNode,
  UnwrappingCandidate,
  UnwrapParameters,
  UnwrapRun,
  UnwrappedPixelValue,
  VersionRef
} from './types.ts';

export interface LockConstraint {
  lockId: string;
  rowA: number;
  colA: number;
  rowB: number;
  colB: number;
  requiredOffsetTurns: number;
  candidateId: string | null;
}

interface Adjacency {
  neighborIndex: number;
  edgeId: string;
}

const TWO_PI = Math.PI * 2;

function phaseAt(pixels: PixelNode[], index: number): number {
  return pixels[index]!.wrappedPhaseRad;
}

function nearestTurns(delta: number): number {
  return -Math.round(delta / TWO_PI);
}

function wrapRad(value: number): number {
  return ((value + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
}

function sameCell(a: { row: number; col: number }, row: number, col: number): boolean {
  return a.row === row && a.col === col;
}

function sourceRefs(params: UnwrapParameters, pixels: PixelNode[]): VersionRef[] {
  const refs: VersionRef[] = [];
  const add = (
    entityId: string,
    version: number,
    contentHash: string,
    entityKind: VersionRef['entityKind'],
    path?: string,
    role?: VersionRef['role']
  ) => refs.push({ entityKind, entityId, version, contentHash, path, role });

  add(params.phaseContentId, 1, params.phaseContentId, 'artifact', 'wrappedPhase', 'wrapped_phase_pixels');
  add(params.amplitudeContentId, 1, params.amplitudeContentId, 'artifact', 'amplitude', 'amplitude_map');
  add(params.qualityContentId, 1, params.qualityContentId, 'artifact', 'signalQuality', 'signal_quality_scores');
  add(params.maskContentId, 1, params.maskContentId, 'artifact', 'invalidMask', 'invalid_mask');
  add(params.wavelengthContentId, 1, params.wavelengthContentId, 'artifact', 'wavelength', 'wavelength');
  add(params.geometryContentId, 1, params.geometryContentId, 'artifact', 'illuminationGeometry', 'illumination_geometry');
  add(params.calibrationContentId, 1, params.calibrationContentId, 'artifact', 'calibrationSurface', 'calibration_surface');
  add(params.cutHistoryContentId, 1, params.cutHistoryContentId, 'artifact', 'cutEditHistory', 'cut_edit_history');
  return pixels.flatMap((pixel) => pixel.refs).concat(refs);
}

export function buildPixels(frame: InterferometryFrameInput): PixelNode[] {
  const pixels: PixelNode[] = [];
  for (let row = 0; row < frame.wrappedPhase.rows; row += 1) {
    for (let col = 0; col < frame.wrappedPhase.cols; col += 1) {
      const index = row * frame.wrappedPhase.cols + col;
      const valid = frame.invalidMask.values[index] === false;
      const wrapped = frame.wrappedPhase.values[index];
      const amplitude = frame.amplitude.values[index];
      const quality = frame.signalQuality.values[index];
      pixels.push({
        pixelId: stableId('pixel', [frame.scenarioId, row, col]),
        row,
        col,
        wrappedPhaseRad: typeof wrapped === 'number' && Number.isFinite(wrapped) ? wrapped : Number.NaN,
        amplitude: typeof amplitude === 'number' && Number.isFinite(amplitude) ? amplitude : Number.NaN,
        qualityScore: typeof quality === 'number' && Number.isFinite(quality) ? quality : Number.NaN,
        valid,
        componentId: null,
        refs: [
          { entityKind: 'artifact', entityId: frame.fragmentBindings.wrapped_phase_pixels[0] ?? frame.scenarioId, version: 1, contentHash: frame.fragmentBindings.wrapped_phase_pixels[0] ?? '', path: `wrappedPhase[${row}][${col}]`, role: 'wrapped_phase_pixels' },
          { entityKind: frame.fragmentBindings.invalid_mask[0] ?? frame.scenarioId, version: 1, contentHash: frame.fragmentBindings.invalid_mask[0] ?? '', path: `invalidMask[${row}][${col}]`, role: 'invalid_mask' }
        ]
      });
    }
  }
  return pixels;
}

export function buildEdges(
  frame: InterferometryFrameInput,
  pixels: PixelNode[],
  params: UnwrapParameters
): PhaseGraphEdge[] {
  const edits = frame.cutEditHistory.edits;
  const edges: PhaseGraphEdge[] = [];
  const addEdge = (rowA: number, colA: number, rowB: number, colB: number) => {
    const indexA = rowA * frame.wrappedPhase.cols + colA;
    const indexB = rowB * frame.wrappedPhase.cols + colB;
    const a = pixels[indexA]!;
    const b = pixels[indexB]!;
    const edit = edits.find((item: CutEdit) =>
      item.edge.rowA === rowA && item.edge.colA === colA && item.edge.rowB === rowB && item.edge.colB === colB
    );
    const wrappedDelta = wrapRad(phaseAt(pixels, indexB) - phaseAt(pixels, indexA));
    const nearest = nearestTurns(phaseAt(pixels, indexB) - phaseAt(pixels, indexA));
    const low = a.amplitude < params.amplitudeThreshold || b.amplitude < params.amplitudeThreshold
      || a.qualityScore < params.qualityThreshold || b.qualityScore < params.qualityThreshold;
    let kind: PhaseGraphEdge['edgeKind'] = 'trusted';
    let diagnostic: string | null = null;
    if (!a.valid || !b.valid) {
      kind = 'mask_boundary';
      diagnostic = 'INVALID_MASK_SEPARATES_PHASE_PIXELS';
    } else if (edit) {
      kind = 'cut';
      diagnostic = edit.reason;
    } else if (low) {
      kind = 'low_amplitude';
      diagnostic = 'LOW_AMPLITUDE_PHASE_MUST_REMAIN_UNGUESSED';
    }
    edges.push({
      edgeId: stableId('edge', [frame.scenarioId, rowA, colA, rowB, colB, edit?.editId ?? null]),
      fromPixelId: a.pixelId,
      toPixelId: b.pixelId,
      rowA,
      colA,
      rowB,
      colB,
      wrappedDeltaRad: wrappedDelta,
      nearestOffsetTurns: nearest,
      explicitOffsetTurns: edit?.explicitOffsetTurns ?? null,
      selectedOffsetTurns: null,
      edgeKind: kind,
      qualityScore: Math.min(a.qualityScore, b.qualityScore),
      componentId: null,
      diagnostic,
      refs: edit
        ? [{ entityKind: 'artifact', entityId: params.cutHistoryContentId, version: 1, contentHash: params.cutHistoryContentId, path: edit.editId, role: 'cut_edit_history' }]
        : []
    });
  };

  for (let row = 0; row < frame.wrappedPhase.rows; row += 1) {
    for (let col = 0; col < frame.wrappedPhase.cols; col += 1) {
      if (col + 1 < frame.wrappedPhase.cols) addEdge(row, col, row, col + 1);
      if (row + 1 < frame.wrappedPhase.rows) addEdge(row, col, row + 1, col);
    }
  }
  return edges;
}

export function labelComponents(pixels: PixelNode[], edges: PhaseGraphEdge[]): void {
  const adjacency = new Map<string, Adjacency[]>();
  for (const pixel of pixels) adjacency.set(pixel.pixelId, []);
  for (const edge of edges) {
    if (edge.edgeKind === 'mask_boundary' || edge.edgeKind === 'low_amplitude') continue;
    adjacency.get(edge.fromPixelId)!.push({ neighborIndex: pixels.findIndex((p) => p.pixelId === edge.toPixelId), edgeId: edge.edgeId });
    adjacency.get(edge.toPixelId)!.push({ neighborIndex: pixels.findIndex((p) => p.pixelId === edge.fromPixelId), edgeId: edge.edgeId });
  }
  const seen = new Set<string>();
  let componentNumber = 0;
  for (const pixel of pixels) {
    if (!pixel.valid || seen.has(pixel.pixelId)) continue;
    const componentId = `component_${componentNumber}`;
    componentNumber += 1;
    const queue = [pixel.pixelId];
    seen.add(pixel.pixelId);
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const current = pixels.find((p) => p.pixelId === currentId)!;
      current.componentId = componentId;
      for (const next of adjacency.get(currentId) ?? []) {
        const neighbor = pixels[next.neighborIndex]!;
        if (!neighbor.valid || seen.has(neighbor.pixelId)) continue;
        seen.add(neighbor.pixelId);
        queue.push(neighbor.pixelId);
      }
    }
  }
  for (const edge of edges) {
    const from = pixels.find((p) => p.pixelId === edge.fromPixelId)!;
    const to = pixels.find((p) => p.pixelId === edge.toPixelId)!;
    edge.componentId = from.componentId === to.componentId ? from.componentId : null;
  }
}

function activeEdges(edges: PhaseGraphEdge[]): PhaseGraphEdge[] {
  return edges.filter((edge) => {
    if (edge.edgeKind === 'mask_boundary' || edge.edgeKind === 'low_amplitude') return false;
    if (edge.edgeKind === 'trusted') return true;
    return edge.explicitOffsetTurns !== null || edge.diagnostic === 'INTEGER_AMBIGUITY_REQUIRES_CANDIDATES';
  });
}

function pixelIndex(pixels: PixelNode[], id: string): number {
  return pixels.findIndex((pixel) => pixel.pixelId === id);
}

function buildForest(
  pixels: PixelNode[],
  edges: PhaseGraphEdge[],
  forcedEdgeIds: string[] = []
): { treeEdgeIds: string[]; rootByPixel: Map<string, string>; parentEdge: Map<string, string> } {
  const usable = activeEdges(edges);
  const ordered = [
    ...usable.filter((edge) => forcedEdgeIds.includes(edge.edgeId)),
    ...usable.filter((edge) => !forcedEdgeIds.includes(edge.edgeId))
  ];
  const parent = new Map<string, string>();
  const parentEdge = new Map<string, string>();
  const rootByPixel = new Map<string, string>();
  const treeEdgeIds: string[] = [];

  for (const pixel of pixels.filter((item) => item.valid)) {
    parent.set(pixel.pixelId, pixel.pixelId);
    rootByPixel.set(pixel.pixelId, pixel.pixelId);
  }
  const find = (id: string): string => {
    let current = id;
    while (parent.get(current) !== current) current = parent.get(current)!;
    return current;
  };
  const union = (edge: PhaseGraphEdge[]) => {
    for (const edge of ordered) {
      const rootA = find(edge.fromPixelId);
      const rootB = find(edge.toPixelId);
      if (rootA === rootB) continue;
      parent.set(rootB, rootA);
      parentEdge.set(edge.toPixelId === rootB ? edge.toPixelId : rootB, edge.edgeId);
      treeEdgeIds.push(edge.edgeId);
      for (const [pixelId] of parent) {
        if (find(pixelId) === rootA || find(pixelId) === rootB) rootByPixel.set(pixelId, find(pixelId));
      }
    }
  };
  union(ordered);
  for (const pixelId of parent.keys()) rootByPixel.set(pixelId, find(pixelId));
  return { treeEdgeIds, rootByPixel, parentEdge };
}

function legalOffsets(edge: PhaseGraphEdge, window: number): number[] {
  if (edge.edgeKind === 'cut' && edge.explicitOffsetTurns !== null) return [edge.explicitOffsetTurns];
  if (edge.edgeKind === 'cut' && edge.diagnostic === 'INTEGER_AMBIGUITY_REQUIRES_CANDIDATES') {
    return Array.from({ length: window * 2 + 1 }, (_, index) => edge.nearestOffsetTurns - window + index);
  }
  return [edge.nearestOffsetTurns];
}

function edgePhaseStep(edge: PhaseGraphEdge, reverse: boolean, offsetTurns: number): number {
  const step = edge.wrappedDeltaRad + TWO_PI * offsetTurns;
  return reverse ? -step : step;
}

function calculateTreePhases(
  pixels: PixelNode[],
  edges: PhaseGraphEdge[],
  treeEdgeIds: string[],
  offsets: Map<string, number>
): Map<string, number> {
  const adjacency = new Map<string, Array<{ neighbor: string; edge: PhaseGraphEdge }>>();
  for (const pixel of pixels) adjacency.set(pixel.pixelId, []);
  for (const edgeId of treeEdgeIds) {
    const edge = edges.find((item) => item.edgeId === edgeId)!;
    adjacency.get(edge.fromPixelId)!.push({ neighbor: edge.toPixelId, edge });
    adjacency.get(edge.toPixelId)!.push({ neighbor: edge.fromPixelId, edge });
  }
  const phases = new Map<string, number>();
  const roots = new Set(
    pixels.filter((pixel) => pixel.valid && !treeEdgeIds.some((edgeId) => {
      const edge = edges.find((item) => item.edgeId === edgeId)!;
      return edge.toPixelId === pixel.pixelId || edge.fromPixelId === pixel.pixelId;
    })).map((pixel) => pixel.pixelId)
  );
  for (const pixel of pixels.filter((item) => item.valid && !phases.has(item.pixelId))) {
    const root = roots.has(pixel.pixelId) ? pixel.pixelId : findRootFromTree(pixel.pixelId, adjacency, treeEdgeIds, edges);
    if (!phases.has(root)) phases.set(root, pixels.find((item) => item.pixelId === root)!.wrappedPhaseRad);
    const queue = [root];
    const seen = new Set([root]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of adjacency.get(current) ?? []) {
        if (seen.has(next.neighbor)) continue;
        const offset = offsets.get(next.edge.edgeId)!;
        const reverse = next.edge.toPixelId === current;
        phases.set(next.neighbor, phases.get(current)! + edgePhaseStep(next.edge, reverse, offset));
        seen.add(next.neighbor);
        queue.push(next.neighbor);
      }
    }
  }
  return phases;
}

function findRootFromTree(
  start: string,
  adjacency: Map<string, Array<{ neighbor: string; edge: PhaseGraphEdge }>>,
  treeEdgeIds: string[],
  edges: PhaseGraphEdge[]
): string {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const links = adjacency.get(current) ?? [];
    if (links.length === 0) return current;
    for (const link of links) {
      if (!seen.has(link.neighbor)) {
        seen.add(link.neighbor);
        queue.push(link.neighbor);
      }
    }
  }
  return start;
}

function candidateCycleResiduals(
  candidateId: string,
  frame: InterferometryFrameInput,
  pixels: PixelNode[],
  edges: PhaseGraphEdge[],
  treeEdgeIds: string[],
  offsets: Map<string, number>,
  phases: Map<string, number>
): CycleResidual[] {
  const result: CycleResidual[] = [];
  for (const edge of activeEdges(edges)) {
    if (treeEdgeIds.includes(edge.edgeId)) continue;
    const phaseA = phases.get(edge.fromPixelId);
    const phaseB = phases.get(edge.toPixelId);
    if (phaseA === undefined || phaseB === undefined) continue;
    const rawResidualRad = phaseB - phaseA - (edge.wrappedDeltaRad + TWO_PI * (offsets.get(edge.edgeId) ?? edge.nearestOffsetTurns));
    const residualTurns = Math.abs(rawResidualRad) < 1e-9 ? 0 : rawResidualRad / TWO_PI;
    result.push({
      cycleId: stableId('cycle', [candidateId, edge.edgeId]),
      candidateId,
      anchorPixelId: edge.fromPixelId,
      edgeIds: [...treePathBetween(edge.fromPixelId, edge.toPixelId, pixels, edges, treeEdgeIds), edge.edgeId],
      residualTurns: Math.abs(residualTurns) < 1e-9 ? 0 : residualTurns,
      status: Math.abs(residualTurns) < 1e-9 ? 'valid' : 'invalid',
      diagnostic: Math.abs(residualTurns) < 1e-9 ? 'CYCLE_CLOSES_TO_ZERO_TURNS' : 'CYCLE_DOES_NOT_CLOSE_INTEGER_TURNS',
      refs: [
        { entityKind: 'artifact', entityId: frame.fragmentBindings.cut_edit_history[0] ?? '', version: 1, contentHash: frame.fragmentBindings.cut_edit_history[0] ?? '', role: 'cut_edit_history' }
      ]
    });
  }
  return result;
}

function treePathBetween(
  from: string,
  to: string,
  pixels: PixelNode[],
  edges: PhaseGraphEdge[],
  treeEdgeIds: string[]
): string[] {
  const adjacency = new Map<string, Array<{ neighbor: string; edgeId: string }>>();
  for (const pixel of pixels) adjacency.set(pixel.pixelId, []);
  for (const edgeId of treeEdgeIds) {
    const edge = edges.find((item) => item.edgeId === edgeId)!;
    adjacency.get(edge.fromPixelId)!.push({ neighbor: edge.toPixelId, edgeId });
    adjacency.get(edge.toPixelId)!.push({ neighbor: edge.fromPixelId, edgeId });
  }
  const queue: Array<{ id: string; path: string[] }> = [{ id: from, path: [] }];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.id === to) return current.path;
    for (const next of adjacency.get(current.id) ?? []) {
      if (seen.has(next.neighbor)) continue;
      seen.add(next.neighbor);
      queue.push({ id: next.neighbor, path: [...current.path, next.edgeId] });
    }
  }
  return [];
}

function satisfiesLocks(
  candidateId: string,
  edges: PhaseGraphEdge[],
  offsets: Map<string, number>,
  locks: LockConstraint[]
): { ok: boolean; reason: string | null } {
  const candidateLocks = locks.filter((lock) => lock.candidateId === null || lock.candidateId === candidateId);
  const byEdge = new Map<string, number[]>();
  for (const lock of candidateLocks) {
    const edge = edges.find((item) =>
      sameCell(item, lock.rowA, lock.colA) && sameCell(item, lock.rowB, lock.colB)
    );
    if (!edge) return { ok: false, reason: 'LOCK_REFERENCES_MISSING_EDGE' };
    const list = byEdge.get(edge.edgeId) ?? [];
    list.push(lock.requiredOffsetTurns);
    byEdge.set(edge.edgeId, list);
  }
  for (const [edgeId, requirements] of byEdge) {
    if (new Set(requirements).size > 1) return { ok: false, reason: `CONFLICTED_LOCAL_LOCKS_ON_${edgeId}` };
    if (offsets.get(edgeId) !== requirements[0]) return { ok: false, reason: `LOCK_REQUIRES_OFFSET_${requirements[0]}` };
  }
  return { ok: true, reason: null };
}

function makeHeights(
  frame: InterferometryFrameInput,
  candidate: UnwrappingCandidate,
  pixelValues: UnwrappedPixelValue[],
  params: UnwrapParameters
): HeightValue[] {
  const wavelength = frame.wavelength;
  const geometry = frame.illuminationGeometry;
  const calibration = frame.calibrationSurface;
  const wavelengthHash = params.wavelengthContentId;
  const geometryHash = params.geometryContentId;
  const calibrationHash = params.calibrationContentId;
  return pixelValues.map((value) => {
    const phase = value.relativeCalibrationPhaseRad;
    const height = phase === null || wavelength.normalizedNanometers === null
      ? null
      : phase * wavelength.normalizedNanometers / (TWO_PI * 2 * geometry.normalizedCosIncidence);
    return {
      heightId: stableId('height', [candidate.candidateId, value.pixelId, wavelengthHash]),
      candidateId: candidate.candidateId,
      pixelId: value.pixelId,
      row: value.row,
      col: value.col,
      heightNanometers: height,
      transferChain: [
        { step: 'raw_wrapped_phase_rad', stepVersion: 1, value: frame.wrappedPhase.values[value.row * frame.wrappedPhase.cols + value.col] ?? null, unit: 'radian', sourceContentHash: params.phaseContentId },
        { step: 'tree_unwrapped_phase_rad', stepVersion: candidate.candidateNumber, value: value.unwrappedPhaseRad, unit: 'radian', sourceContentHash: candidate.refs[0]?.contentHash ?? candidate.candidateId },
        { step: 'calibration_bias_subtracted_rad', stepVersion: 1, value: phase, unit: 'radian', sourceContentHash: calibrationHash },
        { step: 'wavelength_nanometer', stepVersion: 1, value: wavelength.normalizedNanometers, unit: 'nanometer', sourceContentHash: wavelengthHash },
        { step: 'cos_incidence_factor', stepVersion: 1, value: geometry.normalizedCosIncidence, unit: 'dimensionless', sourceContentHash: geometryHash },
        { step: 'four_step_height_nanometer', stepVersion: 1, value: height, unit: 'nanometer', sourceContentHash: candidate.candidateId }
      ],
      status: height === null ? 'unknown' : value.status,
      diagnostic: wavelength.normalizedNanometers === null ? 'WAVELENGTH_NOT_CONVERTED_HEIGHT_LEFT_AT_SOURCE' : null,
      refs: [
        { entityKind: 'artifact', entityId: wavelengthHash, version: 1, contentHash: wavelengthHash, role: 'wavelength' },
        { entityKind: 'artifact', entityId: geometryHash, version: 1, contentHash: geometryHash, role: 'illumination_geometry' },
        { entityKind: 'artifact', entityId: calibrationHash, version: 1, contentHash: calibrationHash, role: 'calibration_surface' }
      ]
    };
  });
}

export function analyzeUnwrapping(
  frame: InterferometryFrameInput,
  params: UnwrapParameters,
  locks: LockConstraint[] = [],
  nowIso: string,
  parentRunId: string | null = null
): UnwrapRun {
  const pixels = buildPixels(frame);
  const edges = buildEdges(frame, pixels, params);
  labelComponents(pixels, edges);

  const ambiguous = activeEdges(edges).filter((edge) => {
    const choices = legalOffsets(edge, params.ambiguityWindowTurns);
    return choices.length > 1;
  });
  const variants: Array<{ forced?: string; offset?: number }> = [{}];
  for (const edge of ambiguous) {
    const choices = legalOffsets(edge, params.ambiguityWindowTurns);
    const expanded: Array<{ forced?: string; offset?: number }> = [];
    for (const variant of variants) {
      for (const offset of choices) expanded.push({ forced: edge.edgeId, offset, ...variant });
    }
    variants.splice(0, variants.length, ...expanded);
  }

  const candidates: UnwrappingCandidate[] = [];
  const rejectedDiagnostics: string[] = [];
  const forest = buildForest(pixels, edges);

  variants.slice(0, 12).forEach((variant, variantIndex) => {
    const treeEdgeIds = forest.treeEdgeIds;
    const offsets = new Map<string, number>();
    for (const edge of activeEdges(edges)) {
      if (variant.forced === edge.edgeId && variant.offset !== undefined) offsets.set(edge.edgeId, variant.offset);
      else offsets.set(edge.edgeId, legalOffsets(edge, params.ambiguityWindowTurns)[0]!);
    }
    if (variant.forced && variant.offset !== undefined && !treeEdgeIds.includes(variant.forced)) {
      const rebuilt = buildForest(pixels, edges, [variant.forced]);
      treeEdgeIds.splice(0, treeEdgeIds.length, ...rebuilt.treeEdgeIds);
    }
    const phases = calculateTreePhases(pixels, edges, treeEdgeIds, offsets);
    const candidateId = stableId('candidate', [frame.scenarioId, params.parameterFingerprint, variantIndex, variant.forced ?? 'nearest', variant.offset ?? '']);
    const cycleResiduals = candidateCycleResiduals(candidateId, frame, pixels, edges, treeEdgeIds, offsets, phases);
    const openCycle = cycleResiduals.find((cycle) => cycle.status === 'invalid');
    const lockCheck = satisfiesLocks(candidateId, edges, offsets, locks);

    const pixelValues: UnwrappedPixelValue[] = pixels.map((pixel) => {
      const phase = pixel.valid ? phases.get(pixel.pixelId) ?? null : null;
      return {
        valueId: stableId('phasevalue', [candidateId, pixel.pixelId]),
        candidateId,
        pixelId: pixel.pixelId,
        row: pixel.row,
        col: pixel.col,
        unwrappedPhaseRad: phase,
        relativeCalibrationPhaseRad: phase === null ? null : phase - frame.calibrationSurface.phaseBias,
        status: pixel.valid ? 'valid' : 'unknown',
        refs: pixel.refs
      };
    });
    const candidateRecord: UnwrappingCandidate = {
      candidateId,
      candidateNumber: variantIndex + 1,
      treeEdgeIds: [...treeEdgeIds],
      rootPixelId: pixels.find((pixel) => pixel.valid)?.pixelId ?? 'pixel_none',
      status: 'proposed',
      statusReason: openCycle ? openCycle.diagnostic : lockCheck.reason ?? 'LOCAL_TREE_CONSISTENT',
      legalIntegerOffsets: Object.fromEntries(activeEdges(edges).map((edge) => [edge.edgeId, legalOffsets(edge, params.ambiguityWindowTurns)])),
      rejectedEdgeIds: edges.filter((edge) => edge.edgeKind === 'low_amplitude' || edge.edgeKind === 'mask_boundary').map((edge) => edge.edgeId),
      cycleResiduals,
      pixels: pixelValues,
      heights: [],
      refs: [
        { entityKind: 'run', entityId: stableId('run', [frame.scenarioId, params.parameterFingerprint, nowIso]), version: 1, contentHash: params.parameterFingerprint }
      ]
    };
    if (openCycle) {
      candidateRecord.status = 'rejected';
      rejectedDiagnostics.push(`${candidateId}:${openCycle.diagnostic}`);
    }
    if (!lockCheck.ok && !openCycle) {
      candidateRecord.status = 'conflicted';
      rejectedDiagnostics.push(`${candidateId}:${lockCheck.reason}`);
    }
    candidateRecord.heights = makeHeights(frame, candidateRecord, pixelValues, params);
    candidates.push(candidateRecord);
  });

  if (ambiguous.length > 0 && candidates.filter((candidate) => candidate.status === 'proposed').length > 1) {
    candidates.filter((candidate) => candidate.status === 'proposed').forEach((candidate, index) => {
      if (index > 0) {
        candidate.status = 'proposed';
        candidate.statusReason = 'MULTIPLE_LEGAL_INTEGER_CANDIDATES_REQUIRE_HUMAN_DECISION';
      }
    });
  }

  const runId = stableId('run', [frame.scenarioId, params.parameterFingerprint, nowIso]);
  for (const candidate of candidates) {
    candidate.refs[0] = { entityKind: 'run', entityId: runId, version: 1, contentHash: params.parameterFingerprint };
  }
  const diagnostics = [
    ...edges.filter((edge) => edge.diagnostic).map((edge) => `${edge.edgeId}:${edge.diagnostic}`),
    ...rejectedDiagnostics
  ];
  return {
    runId,
    parentRunId,
    scenarioId: frame.scenarioId,
    parameters: params,
    parameterFingerprint: params.parameterFingerprint,
    status: candidates.some((candidate) => candidate.status === 'conflicted') ? 'conflicted' : 'current',
    pixels,
    edges,
    candidates,
    diagnostics,
    directSources: sourceRefs(params, pixels),
    createdAt: nowIso
  };
}

export function parameterFingerprint(params: UnwrapParameters): string {
  return stableHash(params);
}

export { TWO_PI };
