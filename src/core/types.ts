// Domain vocabulary for the interferometry ledger. Entities are NOT generic
// name/value rows: every entity is an explicitly named optical artifact.

// ---------------------------------------------------------------------------
// Units & raw representation
// ---------------------------------------------------------------------------

export type AngleUnit = 'rad' | 'deg' | 'turn';
export type LengthUnit = 'nm' | 'um' | 'mm' | 'm';
export type IntensityUnit = 'counts' | 'a.u.';

/** A physical quantity that always carries its unit / coordinate basis. */
export interface Quantity<V = number, U extends string = string> {
  value: V;
  unit: U;
}

export interface CoordinateBasis {
  /** Origin anchor in physical coordinates, e.g. {x:0,y:0}. */
  origin: { x: number; y: number };
  axisUnit: LengthUnit;
  /** Pixel pitch, in axisUnit per pixel; retained, never silently re-scaled. */
  pixelPitch: { x: number; y: number };
}

/** A single parsed sample. Unconvertible raw text stays in place with a diagnostic. */
export interface RawSample {
  /** Exactly what the lab submitted; never discarded or rewritten. */
  raw: string | number | null;
  /** Normalized value only when conversion succeeds. */
  normalized?: number;
  /** Set when raw cannot be converted; the cell is kept, not dropped. */
  diagnostic?: string;
}

export interface Grid2D {
  width: number;
  height: number;
  /** Row-major RawSample cells, length === width*height. */
  cells: RawSample[];
  frameAxis: 'y_down' | 'y_up';
}

// ---------------------------------------------------------------------------
// Provenance identities
// ---------------------------------------------------------------------------

export type EntityKind =
  | 'wrapped_phase'
  | 'amplitude'
  | 'invalid_mask'
  | 'wavelength'
  | 'illumination_geometry'
  | 'calibration_plane'
  | 'cut_edits'
  | 'quality_map'
  | 'residue_map'
  | 'cut_network'
  | 'unwrap_tree'
  | 'cycle_residuals'
  | 'integer_candidates'
  | 'height_chain'
  | 'local_lock';

export const SOURCE_KINDS: ReadonlySet<EntityKind> = new Set<EntityKind>([
  'wrapped_phase',
  'amplitude',
  'invalid_mask',
  'wavelength',
  'illumination_geometry',
  'calibration_plane',
  'cut_edits',
]);

export interface EntityRef {
  entityId: string;
  version: number;
  /** Content digest pinned at reference time; mismatch => corruption. */
  contentDigest: string;
  /** Direct input role, in domain vocabulary. */
  role: string;
}

export interface EntityVersion<C = unknown> {
  entityId: string;
  kind: EntityKind;
  version: number;
  parentVersion: number | null;
  contentDigest: string;
  createdAt: number;
  origin: 'import' | 'derived' | 'decision';
  /**
   * For derived/decision versions: the direct sources. Each derived value carries
   * algorithm version, parameter fingerprint and direct sources.
   */
  derivation?: {
    algorithm: string;
    algorithmVersion: string;
    parameterFingerprint: string;
    sources: EntityRef[];
    stepIndex: number;
  };
  content: C;
}

// ---------------------------------------------------------------------------
// Source (immutable) entity contents
// ---------------------------------------------------------------------------

export interface WrappedPhaseContent {
  grid: Grid2D;
  principalRange: { min: number; max: number };
  unit: AngleUnit;
  coordinateBasis: CoordinateBasis;
  /** Fragment refs shared between minimal & combined scenarios (deduped storage). */
  fragments?: { fragmentId: string; role: string; contentDigest: string }[];
}

export interface AmplitudeContent {
  grid: Grid2D;
  unit: IntensityUnit;
  /** Noise floor estimate used for the signal-to-noise score. */
  noiseFloor: number;
  coordinateBasis: CoordinateBasis;
}

export interface InvalidMaskContent {
  width: number;
  height: number;
  /** 1 = invalid (masked out), 0 = valid. Row-major. */
  invalid: number[];
}

export interface WavelengthContent {
  lambda: Quantity<number, LengthUnit>;
  /** Medium refractive index assumed in optical path conversion. */
  refractiveIndex: number;
  note?: string;
}

export interface IlluminationGeometryContent {
  /** Incident angle of the illumination beam relative to the surface normal. */
  incidenceAngle: Quantity<number, 'deg'>;
  /** Observation angle of the camera relative to the surface normal. */
  observationAngle: Quantity<number, 'deg'>;
  /** Sensitivity factor convention used downstream. */
  convention: 'reflective' | 'transmissive';
}

export interface CalibrationPlaneContent {
  /** Best-fit reference plane z = a*x + b*y + c in calibration coordinates. */
  plane: { a: number; b: number; c: number };
  coordinateUnit: LengthUnit;
  /** Residual rms of the calibration fit; unknown may be null. */
  fitRms: number | null;
  calibrationFrameIds: string[];
}

export interface CutEdit {
  editId: string;
  at: number;
  action: 'add_branch_cut' | 'remove_branch_cut';
  /** Endpoint plaquette indices (x1,y1)-(x2,y2). */
  from: [number, number];
  to: [number, number];
  operator: string;
}

export interface CutEditsContent {
  width: number;
  height: number;
  /** Append-only manual cut operations, never rewritten. */
  edits: CutEdit[];
}

// ---------------------------------------------------------------------------
// Derived / decision entity contents
// ---------------------------------------------------------------------------

export interface QualityMapContent {
  width: number;
  height: number;
  /** Signal-to-noise score in [0,1]; low-amplitude holes are 0. */
  score: number[];
  /** Cells marked "do not guess": amplitude invalid/below threshold. */
  doNotGuess: number[];
  threshold: number;
}

export interface Plaquette {
  x: number;
  y: number;
  /** +1 positive residue, -1 negative residue, 0 irrotational. */
  charge: -1 | 0 | 1;
  /** Raw wrapped sum around the 2x2 plaquette. */
  wrappedSum: number;
}

export interface ResidueMapContent {
  width: number;
  height: number;
  plaquettes: Plaquette[];
  boundaryPlaquettes: { x: number; y: number; reason: string }[];
}

export interface CutEdge {
  from: [number, number];
  to: [number, number];
  /**
   * Explicit integer-cycle offset across the cut: the unwrapped phase on the
   * `to` side equals the `from` side plus 2*pi*k. k may be an array when
   * multiple legal integers remain.
   */
  integerOffset: number | number[];
  origin: 'auto_balanced' | 'manual' | 'boundary';
  /** Why an offset is undetermined, when applicable. */
  unresolvedReason?: string;
}

export interface CutNetworkContent {
  width: number;
  height: number;
  edges: CutEdge[];
  unbalancedResidues: { x: number; y: number; charge: -1 | 1 }[];
}

export interface TreeEdge {
  from: number;
  to: number;
  /** Signed wrapped gradient, principal value, radians. */
  wrap: number;
  /** Chosen integer correction; multiple legal values may remain. */
  k: number | number[];
  crossesCut: boolean;
  residueCharge?: -1 | 0 | 1;
}

export interface UnwrapTreeContent {
  width: number;
  height: number;
  /** Each connected valid region gets its own spanning forest. */
  components: {
    componentId: string;
    root: number;
    nodeCount: number;
    edges: TreeEdge[]
  }[];
  /** Per-cell unwrapped phase (radians); null in do-not-guess / masked cells. */
  unwrapped: (number | null)[];
}

export interface CycleRecord {
  cycleId: string;
  nodes: number[];
  /** Sum of integer corrections around the cycle; 0 means it closes. */
  integerResidual: number;
  closes: boolean;
  diagnostic: string;
}

export interface CycleResidualsContent {
  cycles: CycleRecord[];
}

export interface IntegerCandidate {
  candidateId: string;
  region: number[];
  /** Legal whole-cycle offset(s) that are locally consistent. */
  legalK: number[];
  chosenK: number | null;
  rejectedK: { k: number; reason: string }[];
  /** Unknown when no unique integer can be decided. */
  status: 'unique' | 'multi' | 'unknown';
  reason: string;
}

export interface IntegerCandidatesContent {
  candidates: IntegerCandidate[];
}

export interface HeightStep {
  step: string;
  inputDigest: string;
  formula: string;
  unit: LengthUnit;
  /** Per-cell output; null where the phase is unknown. */
  values: (number | null)[];
}

export interface HeightChainContent {
  width: number;
  height: number;
  steps: HeightStep[];
  /** Final surface height after calibration-plane removal. */
  surfaceHeight: (number | null)[];
}

export interface LocalLockContent {
  lockId: string;
  anchorCell: number;
  chosenCandidateId: string | null;
  chosenK: number;
  rationale: string;
  scope: number[];
  state: 'proposed' | 'accepted' | 'rejected' | 'superseded';
  conflictsWith: string[];
}

// ---------------------------------------------------------------------------
// Events / state machine
// ---------------------------------------------------------------------------

export type ScenarioTag =
  | 'phase_branch_boundary'
  | 'low_amplitude_hole'
  | 'multi_connected_region'
  | 'unclosed_cycle'
  | 'wavelength_version_change'
  | 'integer_multiplicity'
  | 'local_lock_conflict';

export type DecisionKind =
  | 'cut_edit_committed'
  | 'candidate_chosen'
  | 'candidate_rejected'
  | 'local_lock_proposed'
  | 'local_lock_accepted'
  | 'local_lock_rejected'
  | 'height_accepted'
  | 'height_rejected'
  | 'parameter_revision'
  | 'derived_run'
  | 'scenario_recorded';

export interface DomainEventPayload {
  type:
    | 'project_created'
    | 'source_committed'
    | 'derived_computed'
    | DecisionKind;
  entityId?: string;
  version?: number;
  scenario?: ScenarioTag;
  accepted?: boolean;
  note?: string;
  /** Machine-readable judgments (e.g. low-amplitude / explicit-offset rules). */
  judgments?: JudgmentEvent[];
  affected?: string[];
  [key: string]: unknown;
}

export interface JudgmentEvent {
  ruleId: RuleId;
  verdict: 'holds' | 'violated' | 'inconclusive';
  target: string;
  evidence: Record<string, unknown>;
}

export type RuleId =
  | 'R1_RAW_IMMUTABLE'
  | 'R2_LOW_AMPLITUDE_NO_GUESS'
  | 'R3_CUT_OFFSET_EXPLICIT'
  | 'R4_MULTIPLE_UNWRAP_TREES'
  | 'R5_PATH_AND_CYCLE_RESIDUAL'
  | 'R6_PINNED_VERSION_NO_LATEST_FALLBACK'
  | 'R7_LOCAL_CHANGE_LOCAL_EXPIRY'
  | 'R8_FRAGMENT_SINGLE_STORAGE'
  | 'R9_WAVELENGTH_VERSION_AWARE'
  | 'R10_LOCK_CONFLICT_RECORDED';

export interface DomainEvent {
  eventId: string;
  seq: number;
  projectId: string;
  at: number;
  payload: DomainEventPayload;
  /** Entities/versions materialized by this event. */
  produced: EntityRef[];
  /** Previous event id, forming a tamper-evident chain. */
  prevEventId: string | null;
}

// ---------------------------------------------------------------------------
// Counter-example dossier
// ---------------------------------------------------------------------------

export interface ScenarioRecord {
  tag: ScenarioTag;
  baselineDigest: string;
  singleSourceChanged: string;
  minimalInputDigest: string;
  combinedInputDigest: string;
  sharedFragmentIds: string[];
  affected: string[];
  unaffected: string[];
  containmentCorrect: boolean;
  acceptedResult: string | null;
  rejectedResults: string[];
  judgments: JudgmentEvent[];
}
