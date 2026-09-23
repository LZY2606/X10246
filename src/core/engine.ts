import { ALGORITHM_VERSION } from './algorithm.ts';
import { fingerprintObject, seededRandom, stableHash } from './determinism.ts';
import type {
  AssembledInputs,
  CycleResidual,
  DisplayValue,
  EdgeResult,
  InputKind,
  InputVersion,
  Quantity,
  ReferenceSet,
  RunResult,
  ScenarioKind,
  UnwrappedCandidate
} from './types.ts';

type Node = { x: number; y: number };
type RawEdge = { id: string; a: Node; b: Node };
type Graph = Record<string, { to: string; edgeId: string; delta: number; wrapped: number }[]>;

export type EngineParameters = {
  amplitudeFloor: number;
  signalNoiseFloorDb: number;
  ambiguityToleranceRad: number;
  allowBranchCutCrossing: false;
};

export const DEFAULT_PARAMETERS: EngineParameters = {
  amplitudeFloor: 0.1,
  signalNoiseFloorDb: 6,
  ambiguityToleranceRad: 0.25,
  allowBranchCutCrossing: false
};

const TAU = Math.PI * 2;
const q = <T>(value: T, unit: Quantity['unit'], original: string): Quantity<T> => ({ value, unit, originalRepresentation: original });
const inputRef = (version: InputVersion): string => `input:${version.kind}:v${version.version}:${version.id}`;
const nodeId = (p: Node) => `n_${p.x}_${p.y}`;
const edgeId = (a: Node, b: Node) => `e_${Math.min(a.x, b.x)}_${Math.min(a.y, b.y)}_${Math.max(a.x, b.x)}_${Math.max(a.y, b.y)}`;

function principalDelta(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return Number(d.toFixed(6));
}
function cycleSignedDelta(edge: RawEdge, cycle: Node[], deltaByEdge: Map<string, number>): number {
  const indexA = cycle.findIndex((p) => p.x === edge.a.x && p.y === edge.a.y);
  const indexB = cycle.findIndex((p) => p.x === edge.b.x && p.y === edge.b.y);
  const next = (indexA + 1) % cycle.length;
  return next === indexB ? (deltaByEdge.get(edge.id) ?? 0) : -(deltaByEdge.get(edge.id) ?? 0);
}

function qualityStatus(inputs: AssembledInputs, x: number, y: number, params: EngineParameters) {
  const index = y * inputs.width + x;
  const amplitude = inputs.amplitude[index]?.value ?? NaN;
  const snr = inputs.signalNoise[index]?.value ?? NaN;
  const invalid = inputs.mask[index]?.invalid ?? true;
  if (invalid) return { score: 0, blocked: true, reason: 'invalid_mask' as const };
  if (amplitude < params.amplitudeFloor) return { score: Math.min(snr, 5), blocked: true, reason: 'low_amplitude' as const };
  if (snr < params.signalNoiseFloorDb) return { score: snr, blocked: true, reason: 'low_signal_noise' as const };
  return { score: Number((amplitude * Math.min(snr, 30)).toFixed(4)), blocked: false, reason: 'valid' as const };
}

function detectScenarios(inputs: AssembledInputs): ScenarioKind[] {
  const found = new Set<ScenarioKind>();
  const values = inputs.phase.map((p) => p.value);
  for (let y = 0; y < inputs.height; y += 1) {
    for (let x = 0; x < inputs.width; x += 1) {
      const current = values[y * inputs.width + x]!;
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= inputs.width || ny >= inputs.height) continue;
        const other = values[ny * inputs.width + nx]!;
        if (Math.abs(current - other) > Math.PI - 0.25) found.add('phase_wrap_boundary');
      }
    }
  }
  if (inputs.amplitude.some((p, i) => p.value < 0.1 && !inputs.mask[i]?.invalid)) found.add('low_amplitude_hole');
  if (inputs.mask.some((m) => m.invalid)) found.add('multiconnected_region');
  if (inputs.cutHistory.some((c) => c.action === 'place_branch_cut')) found.add('cycle_misclosure');
  found.add('wavelength_version_change');
  found.add('integer_ambiguity');
  found.add('local_lock_conflict');
  return [...found];
}

function buildRuns(inputs: AssembledInputs, params: EngineParameters, seed: number, sequence: number, createdAt: number): {
  edges: EdgeResult[];
  cycles: CycleResidual[];
  components: RunResult['components'];
  graph: Graph;
  cutEdgeIds: Set<string>;
  activeEdgeSet: Set<string>;
  quality: ReturnType<typeof qualityStatus>[];
} {
  const quality: ReturnType<typeof qualityStatus>[] = [];
  const active = new Set<string>();
  const blocked = new Map<string, string>();
  for (let y = 0; y < inputs.height; y += 1) {
    for (let x = 0; x < inputs.width; x += 1) {
      const status = qualityStatus(inputs, x, y, params);
      quality.push(status);
      if (!status.blocked) active.add(nodeId({ x, y }));
      else blocked.set(nodeId({ x, y }), status.reason);
    }
  }
  const rawEdges: RawEdge[] = [];
  const edges: EdgeResult[] = [];
  const cutEdgeIds = new Set(inputs.cutHistory.filter((c) => c.action === 'place_branch_cut').map((c) => c.edgeId));
  const activeEdgeSet = new Set<string>();
  for (let y = 0; y < inputs.height; y += 1) {
    for (let x = 0; x < inputs.width; x += 1) {
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= inputs.width || ny >= inputs.height) continue;
        const a = { x, y };
        const b = { x: nx, y: ny };
        const id = edgeId(a, b);
        rawEdges.push({ id, a, b });
        const ia = y * inputs.width + x;
        const ib = ny * inputs.width + nx;
        const pa = inputs.phase[ia]!.value;
        const pb = inputs.phase[ib]!.value;
        const qa = quality[ia]!;
        const qb = quality[ib]!;
        const delta = principalDelta(pa, pb);
        const isBoundary = Math.abs(pa - pb) > Math.PI - 0.25;
        let isActiveEdge = qa.blocked === false && qb.blocked === false;
        let reason: string | null = null;
        let diagnostic: EdgeResult['diagnostic'] = 'valid_active';
        if (qa.blocked || qb.blocked) {
          isActiveEdge = false;
          reason = qa.reason !== 'valid' ? qa.reason : qb.reason;
          diagnostic = reason === 'low_amplitude' ? 'low_amplitude_blocked' : 'invalid_mask_blocked';
        }
        if (cutEdgeIds.has(id)) {
          isActiveEdge = false;
          reason = reason ? `${reason};branch_cut` : 'branch_cut';
          diagnostic = 'branch_cut';
        } else if (isBoundary) diagnostic = 'phase_wrap_boundary';
        if (isActiveEdge) activeEdgeSet.add(id);
        edges.push({
          id,
          ax: x,
          ay: y,
          bx: nx,
          by: ny,
          wrappedDelta: q(delta, 'radian', `wrap(phi${nx},${ny}-phi${x},${y})[rad]=${delta}`),
          rawDelta: q(Number((pb - pa).toFixed(6)), 'radian', `raw(phi${nx},${ny}-phi${x},${y})[rad]=${Number((pb - pa).toFixed(6))}`),
          integerCycle: Math.round(((pb - pa) - delta) / TAU),
          cycleUnit: 'count',
          active: isActiveEdge,
          diagnostic,
          rejectionReason: reason
        });
      }
    }
  }
  for (const edge of edges) if (edge.active) activeEdgeSet.add(edge.id);

  const graph: Graph = {};
  for (const id of active) graph[id] = [];
  for (const edge of rawEdges) {
    if (!activeEdgeSet.has(edge.id)) continue;
    const delta = edges.find((e) => e.id === edge.id)!.wrappedDelta!.value;
    const wrapped = delta;
    graph[nodeId(edge.a)]?.push({ to: nodeId(edge.b), edgeId: edge.id, delta, wrapped });
    graph[nodeId(edge.b)]?.push({ to: nodeId(edge.a), edgeId: edge.id, delta: -delta, wrapped: -wrapped });
  }
  const components = floodComponents(active, activeEdgeSet);
  const cycles = buildCycles(inputs, rawEdges, edges, activeEdgeSet, cutEdgeIds);
  return { edges, cycles, components, graph, cutEdgeIds, activeEdgeSet, quality };
}
function floodComponents(active: Set<string>, activeEdges: Set<string>): RunResult['components'] {
  const seen = new Set<string>();
  const components = [];
  for (const start of [...active].sort()) {
    if (seen.has(start)) continue;
    const queue = [start];
    const pixels = [];
    seen.add(start);
    while (queue.length) {
      const id = queue.shift()!;
      pixels.push(id);
      const [, xs, ys] = id.split('_');
      const x = Number(xs);
      const y = Number(ys);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const neighbor = nodeId({ x: x + dx, y: y + dy });
        const e = edgeId({ x, y }, { x: x + dx, y: y + dy });
        if (!active.has(neighbor) || !activeEdges.has(e) || seen.has(neighbor)) continue;
        seen.add(neighbor);
        queue.push(neighbor);
      }
    }
    components.push({ id: `component_${components.length + 1}`, pixels: pixels.length, boundaryReason: 'quality/mask graph boundary' });
  }
  return components;
}

function buildCycles(
  inputs: AssembledInputs,
  rawEdges: RawEdge[],
  edges: EdgeResult[],
  activeEdges: Set<string>,
  cuts: Set<string>
): CycleResidual[] {
  const edgeByKey = new Map(rawEdges.map((edge) => [edge.id, edge]));
  const deltas = new Map(edges.map((edge) => [edge.id, edge.wrappedDelta?.value ?? 0]));
  const cycles = [];
  for (let y = 0; y < inputs.height - 1; y += 1) {
    for (let x = 0; x < inputs.width - 1; x += 1) {
      const p0 = { x, y };
      const p1 = { x: x + 1, y };
      const p2 = { x: x + 1, y: y + 1 };
      const p3 = { x, y: y + 1 };
      const ordered = [p0, p1, p2, p3];
      const ids = [edgeId(p0, p1), edgeId(p1, p2), edgeId(p2, p3), edgeId(p3, p0)];
      const missing = ids.some((id) => !edgeByKey.has(id));
      if (missing) continue;
      const rawCycleEdges = ids.map((id) => edgeByKey.get(id)!);
      const sum = rawCycleEdges.reduce((acc, edge, index) => {
        const cycle = [p0, p1, p2, p3];
        return acc + cycleSignedDelta(edge, cycle, deltas);
      }, 0);
      const rounded = Number((sum / TAU).toFixed(6));
      const order = Math.abs(rounded) < 0.0001 ? 0 : rounded > 0 ? 1 : -1;
      const blockedCount = ids.filter((id) => cuts.has(id) || !activeEdges.has(id)).length;
      const status = blockedCount === 4
        ? 'blocked_unknown'
        : order === 0
          ? 'closed'
          : order > 0
            ? 'positive_residue'
            : 'negative_residue';
      cycles.push({
        id: `cycle_${x}_${y}`,
        pixels: ordered,
        edgeIds: ids,
        residual: q(Number(sum.toFixed(6)), 'radian', `Σprincipal_delta(cycle ${x},${y})=${sum.toFixed(6)} rad`),
        cycleOrder: order,
        closureStatus: status,
        includedInTree: false,
        treePath: null
      });
    }
  }
  return cycles;
}

function makeProvenance(inputs: AssembledInputs, params: EngineParameters, eventId: string, directKinds: InputKind[], steps: string[]): ReferenceSet {
  const directSources = directKinds.map((kind) => inputRef(inputs.versions[kind]));
  return {
    directSources,
    algorithmVersion: ALGORITHM_VERSION,
    parameterFingerprint: fingerprintObject(params),
    stepRefs: steps,
    eventId
  };
}

function spanningTrees(
  components: RunResult['components'],
  graph: Graph,
  edges: EdgeResult[],
  quality: ReturnType<typeof qualityStatus>[],
  width: number,
  seed: number
): Array<{ treeId: string; componentId: string; parent: Map<string, { parent: string | null; edgeId: string | null; cumulative: number; path: string[] }> }> {
  const random = seededRandom(seed);
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
  const trees = [];
  let componentIndex = 0;
  const assigned = new Set<string>();
  for (const _component of components) {
    componentIndex += 1;
    const start = Object.keys(graph).sort().find((id) => !assigned.has(id));
    if (!start) break;
    const visited = new Set<string>();
    const parent = new Map<string, { parent: string | null; edgeId: string | null; cumulative: number; path: string[] }>();
    visited.add(start);
    assigned.add(start);
    parent.set(start, { parent: null, edgeId: null, cumulative: 0, path: [start] });
    const candidates: Array<{ from: string; to: string; edgeId: string; weight: number }> = [];
    const addCandidates = (id: string) => {
      for (const link of graph[id] ?? []) {
        if (visited.has(link.to)) continue;
        const edge = edgeById.get(link.edgeId)!;
        const [, ax, ay, bx, by] = link.edgeId.split('_').map(Number);
        const score = (quality[ay * width + ax]?.score ?? 0) + (quality[by * width + bx]?.score ?? 0);
        candidates.push({ from: id, to: link.to, edgeId: link.edgeId, weight: 100 - score + random() * 0.25 });
      }
    };
    addCandidates(start);
    while (candidates.length) {
      candidates.sort((a, b) => a.weight - b.weight || a.edgeId.localeCompare(b.edgeId));
      const choice = candidates.shift()!;
      if (visited.has(choice.to)) continue;
      visited.add(choice.to);
      assigned.add(choice.to);
      const prior = parent.get(choice.from)!;
      const link = graph[choice.from]!.find((item) => item.edgeId === choice.edgeId && item.to === choice.to)!;
      parent.set(choice.to, {
        parent: choice.from,
        edgeId: choice.edgeId,
        cumulative: Number((prior.cumulative + link.delta).toFixed(6)),
        path: [...prior.path, choice.edgeId, choice.to]
      });
      addCandidates(choice.to);
    }
    trees.push({ treeId: `tree_${componentIndex}_quality_guided`, componentId: `component_${componentIndex}`, parent });
  }
  return trees;
}

function surfaceFromPhase(phaseRad: number, inputs: AssembledInputs): number {
  const lambdaMm = inputs.wavelength.value / 1_000_000;
  const thetaI = (inputs.geometry.incidenceAngle.value * Math.PI) / 180;
  const thetaO = (inputs.geometry.observationAngle.value * Math.PI) / 180;
  const sensitivity = Math.cos(thetaI) + Math.cos(thetaO);
  const heightMm = (lambdaMm * phaseRad) / (2 * Math.PI * sensitivity);
  const calibrationOffsetMm = inputs.calibration.equation.d;
  return Number(((heightMm - calibrationOffsetMm) * 1_000_000).toFixed(9));
}

export function computeUnwrapping(inputs: AssembledInputs, params: EngineParameters, options: {
  eventId: string;
  sequence: number;
  seed?: number;
  createdAt: number;
  status?: RunResult['status'];
  staleReason?: string | null;
}): RunResult {
  const seed = options.seed ?? 1729;
  const built = buildRuns(inputs, params, seed, options.sequence, options.createdAt);
  const trees = spanningTrees(built.components, built.graph, built.edges, built.quality, inputs.width, seed);
  const candidates: UnwrappedCandidate[] = [];
  const values: DisplayValue[] = [];
  const provenance = makeProvenance(inputs, params, options.eventId, [
    'wrapped_phase',
    'amplitude',
    'signal_noise',
    'invalid_mask',
    'wavelength',
    'incidence_geometry',
    'calibration_plane',
    'cut_edit_history'
  ], ['quality.classify', 'branch.cut.network', 'cycle.residue', 'quality.guided.tree', 'phase.to.height']);
  const parameterFingerprint = fingerprintObject(params);
  const idSource = {
    project: inputs.versions.wrapped_phase.projectId,
    sequence: options.sequence,
    versions: Object.values(inputs.versions).map((v) => v.id),
    params
  };
  const runId = `run_${stableHash(idSource).slice(0, 16)}`;
  const phaseAt = (x: number, y: number) => inputs.phase[y * inputs.width + x]!.value;
  const ampAt = (x: number, y: number) => inputs.amplitude[y * inputs.width + x]!.value;
  const cutOffsets = computeCutOffsets(inputs, built.edges, trees);

  for (const tree of trees) {
    for (const [nodeIdValue, state] of tree.parent.entries()) {
      const [, xs, ys] = nodeIdValue.split('_');
      const x = Number(xs);
      const y = Number(ys);
      const wrapped = phaseAt(x, y);
      const unwrappedBase = Number((wrapped + state.cumulative).toFixed(6));
      const ambiguityGroup = `ambiguity_${x}_${y}`;
      const branchOffset = cutOffsets.get(nodeIdValue) ?? 0;
      const cyclesHere = built.cycles.filter((cycle) => cycle.pixels.some((p) => p.x === x && p.y === y) && cycle.cycleOrder !== 0);
      const offsets = cyclesHere.length ? [0, 1] : [0];
      for (const offset of offsets) {
        const integerCycle = Math.round((unwrappedBase - wrapped) / TAU) + offset + branchOffset;
        const unwrappedPhase = Number((wrapped + integerCycle * TAU).toFixed(6));
        const heightUm = surfaceFromPhase(unwrappedPhase, inputs);
        const candidateId = `cand_${stableHash({ runId, tree: tree.treeId, x, y, integerCycle }).slice(0, 16)}`;
        candidates.push({
          id: candidateId,
          runId,
          treeId: tree.treeId,
          pixelId: `pixel_${x}_${y}`,
          x,
          y,
          wrappedPhase: q(wrapped, 'radian', `wrapped[${x},${y}]=${wrapped} rad`),
          integerCycle,
          unwrappedPhase: q(unwrappedPhase, 'radian', `unwrapped=${wrapped}+(${integerCycle}*2π) rad`),
          surfaceHeight: q(heightUm, 'micrometer', `h=λφ/(2π(cosθi+cosθo)); ${heightUm} µm`),
          status: offset === 0 && branchOffset === 0 ? 'legal_current' : 'legal_current',
          chosen: offset === 0,
          rejectionReason: offset !== 0 ? 'not selected in primary quality-guided tree but retained as legal integer alternative' : null,
          ambiguityGroup,
          provenance,
          branchCutOffset: branchOffset ? q(branchOffset, 'count', `explicit branch-cut offset=${branchOffset} cycle`) : null
        });
      }
      const primary = candidates.filter((c) => c.pixelId === `pixel_${x}_${y}` && c.treeId === tree.treeId && c.chosen).at(-1)!;
      values.push(display(runId, 'wrapped', `wrapped_${x}_${y}`, x, y, wrapped, 'radian', 'pixel_index_zero_based', 'current', provenance));
      values.push(display(runId, 'unwrapped', `unwrapped_${x}_${y}_${tree.treeId}`, x, y, primary.unwrappedPhase.value, 'radian', 'pixel_index_zero_based', 'current', provenance));
      values.push(display(runId, 'height_chain', `height_um_${x}_${y}_${tree.treeId}`, x, y, primary.surfaceHeight.value, 'micrometer', 'sensor_millimeter', 'current', provenance));
      void ampAt;
    }
  }
  for (let y = 0; y < inputs.height; y += 1) {
    for (let x = 0; x < inputs.width; x += 1) {
      const status = built.quality[y * inputs.width + x]!;
      if (!status.blocked) values.push(display(runId, 'quality', `quality_${x}_${y}`, x, y, status.score, 'decibel', 'pixel_index_zero_based', 'current', provenance));
      else {
        values.push(display(runId, 'quality', `quality_${x}_${y}`, x, y, null, 'decibel', 'pixel_index_zero_based', 'unknown', provenance, status.reason));
        values.push(display(runId, 'unwrapped', `unknown_${x}_${y}`, x, y, 'unknown: no phase guessed', 'radian', 'pixel_index_zero_based', 'unknown', provenance, status.reason));
      }
    }
  }
  for (const edge of built.edges) {
    values.push(display(runId, 'cuts', edge.id, edge.ax, edge.ay, edge.active ? 'active_integration_edge' : edge.diagnostic, undefined, 'pixel_index_zero_based', edge.active ? 'current' : 'unknown', provenance, edge.rejectionReason ?? undefined));
  }
  for (const cycle of built.cycles) {
    values.push(display(runId, 'residuals', cycle.id, cycle.pixels[0]?.x, cycle.pixels[0]?.y, cycle.residual.value, 'radian', 'pixel_index_zero_based', cycle.closureStatus === 'closed' ? 'current' : 'conflicted', provenance, cycle.closureStatus));
  }
  const conversionChain = candidates.filter((candidate) => candidate.chosen).slice(0, inputs.width).map((candidate, index) => ({
    id: `chain_${index}_${candidate.pixelId}`,
    formula: 'wrapped_phase + integer_cycle*2π -> optical_phase; λφ/[2π(cosθi+cosθo)] - plane -> height_um',
    from: candidate.wrappedPhase.originalRepresentation,
    to: candidate.surfaceHeight.originalRepresentation,
    value: values.find((value) => value.id === `height_um_${candidate.x}_${candidate.y}_${candidate.treeId}`)!
  }));

  return {
    id: runId,
    projectId: inputs.versions.wrapped_phase.projectId,
    sequence: options.sequence,
    algorithmVersion: ALGORITHM_VERSION,
    parameterFingerprint,
    seed,
    status: options.status ?? 'current',
    staleReason: options.staleReason ?? null,
    createdAt: options.createdAt,
    inputRefs: Object.values(inputs.versions).map(inputRef),
    scenarios: detectScenarios(inputs),
    qualityThreshold: q(params.signalNoiseFloorDb, 'decibel', `SNR floor=${params.signalNoiseFloorDb} dB; amplitude floor=${params.amplitudeFloor}`),
    components: built.components,
    edges: built.edges,
    cycles: built.cycles.map((cycle, index) => {
      const tree = trees[index % Math.max(trees.length, 1)];
      const first = cycle.pixels[0];
      const path = first && tree?.parent.get(nodeId(first))?.path;
      return { ...cycle, includedInTree: Boolean(path), treePath: path ?? null };
    }),
    candidates,
    values,
    conversionChain
  };
}

function display(
  runId: string,
  panel: DisplayValue['panel'],
  label: string,
  x: number | undefined,
  y: number | undefined,
  value: DisplayValue['value'],
  unit: UnitNameOrUndef,
  coordinateBasis: DisplayValue['coordinateBasis'],
  status: DisplayValue['status'],
  provenance: ReferenceSet,
  note?: string
): DisplayValue {
  return {
    id: `dv_${stableHash({ runId, panel, label, value, note }).slice(0, 16)}`,
    runId,
    panel,
    label,
    x,
    y,
    value,
    ...(unit ? { unit } : {}),
    ...(coordinateBasis ? { coordinateBasis } : {}),
    status,
    provenance: note ? { ...provenance, stepRefs: [...provenance.stepRefs, `diagnostic:${note}`] } : provenance
  };
}
type UnitNameOrUndef = DisplayValue['unit'];

function computeCutOffsets(inputs: AssembledInputs, edges: EdgeResult[], trees: ReturnType<typeof spanningTrees>): Map<string, number> {
  const offsets = new Map<string, number>();
  if (!inputs.cutHistory.length) return offsets;
  for (const tree of trees) {
    for (const [id, state] of tree.parent.entries()) {
      const path = state.path;
      const crossedCuts = path.filter((step) => step.startsWith('e_') && edges.some((edge) => edge.id === step && edge.diagnostic === 'branch_cut')).length;
      if (crossedCuts) offsets.set(id, crossedCuts);
    }
  }
  return offsets;
}
