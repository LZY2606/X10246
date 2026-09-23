export type InputKind =
  | 'wrapped_phase'
  | 'amplitude'
  | 'signal_noise'
  | 'invalid_mask'
  | 'wavelength'
  | 'incidence_geometry'
  | 'calibration_plane'
  | 'cut_edit_history';

export type ScenarioKind =
  | 'phase_wrap_boundary'
  | 'low_amplitude_hole'
  | 'multiconnected_region'
  | 'cycle_misclosure'
  | 'wavelength_version_change'
  | 'integer_ambiguity'
  | 'local_lock_conflict'
  | 'combined_narrative';

export type UnitName =
  | 'radian'
  | 'nanometer'
  | 'millimeter'
  | 'micrometer'
  | 'dimensionless'
  | 'decibel'
  | 'degree'
  | 'radian_per_cycle'
  | 'count';

export type CoordinateBasis = 'pixel_index_zero_based' | 'sensor_millimeter' | 'fractional_calibration_plane';

export type Quantity<T = number> = {
  value: T;
  unit: UnitName;
  originalRepresentation: string;
  coordinateBasis?: CoordinateBasis;
};

export type PixelDatum = Quantity<number> & { x: number; y: number };

export type MaskDatum = {
  x: number;
  y: number;
  invalid: boolean;
  reason: 'valid' | 'low_amplitude' | 'mask_imported' | 'outside_calibration';
  originalRepresentation: string;
};

export type WavelengthSource = Quantity<number> & {
  mediumRefractiveIndex: number;
  mediumRefractiveIndexRepresentation: string;
};

export type IncidenceGeometry = {
  incidenceAngle: Quantity<number>;
  observationAngle: Quantity<number>;
  sensitivityVector: { x: number; y: number; z: number; basis: CoordinateBasis };
};

export type CalibrationPlane = {
  equation: { a: number; b: number; c: number; d: number };
  equationUnit: { a: UnitName; b: UnitName; c: UnitName; d: UnitName };
  origin: { x: number; y: number; z: number };
  coordinateBasis: CoordinateBasis;
  originalRepresentation: string;
};

export type CutEdit = {
  edgeId: string;
  action: 'place_branch_cut' | 'remove_branch_cut';
  reason: string;
  editor: 'goldstein_residue_rule' | 'human_reviewer';
};

export type GridFragments = Record<'wrapped_phase' | 'amplitude' | 'signal_noise' | 'invalid_mask', string[]>;

export type InputVersion = {
  id: string;
  projectId: string;
  kind: InputKind;
  version: number;
  parentVersionId: string | null;
  fragmentIds: string[];
  digest: string;
  sourceLabel: string;
  scope: 'global' | 'local_patch';
  createdAt: number;
};

export type Fragment = {
  id: string;
  kind: InputKind | 'tile';
  role?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  unit?: UnitName;
  coordinateBasis?: CoordinateBasis;
  originalRepresentation: string;
  data: unknown;
  sha256: string;
};

export type AssembledInputs = {
  width: number;
  height: number;
  phase: PixelDatum[];
  amplitude: PixelDatum[];
  signalNoise: PixelDatum[];
  mask: MaskDatum[];
  wavelength: WavelengthSource;
  geometry: IncidenceGeometry;
  calibration: CalibrationPlane;
  cutHistory: CutEdit[];
  versions: Record<InputKind, InputVersion>;
};

export type ReferenceSet = {
  directSources: string[];
  algorithmVersion: string;
  parameterFingerprint: string;
  stepRefs: string[];
  eventId: string;
};

export type EdgeDiagnostic =
  | 'valid_active'
  | 'low_amplitude_blocked'
  | 'invalid_mask_blocked'
  | 'branch_cut'
  | 'phase_wrap_boundary'
  | 'non_tree_edge';

export type EdgeResult = {
  id: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  wrappedDelta: Quantity<number> | null;
  rawDelta: Quantity<number> | null;
  integerCycle: number | null;
  cycleUnit: UnitName;
  active: boolean;
  diagnostic: EdgeDiagnostic;
  rejectionReason: string | null;
};

export type CycleResidual = {
  id: string;
  pixels: Array<{ x: number; y: number }>;
  edgeIds: string[];
  residual: Quantity<number>;
  cycleOrder: number;
  closureStatus: 'closed' | 'positive_residue' | 'negative_residue' | 'blocked_unknown';
  includedInTree: boolean;
  treePath: string[] | null;
};

export type UnwrappedCandidate = {
  id: string;
  runId: string;
  treeId: string;
  pixelId: string;
  x: number;
  y: number;
  wrappedPhase: Quantity<number>;
  integerCycle: number;
  unwrappedPhase: Quantity<number>;
  surfaceHeight: Quantity<number>;
  status: 'legal_current' | 'legal_stale' | 'accepted' | 'rejected' | 'conflicted' | 'unknown';
  chosen: boolean;
  rejectionReason: string | null;
  ambiguityGroup: string;
  provenance: ReferenceSet;
  branchCutOffset: Quantity<number> | null;
};

export type LocalLock = {
  id: string;
  projectId: string;
  candidateId: string;
  pixelId: string;
  treeId: string;
  runId: string;
  decision: 'accepted' | 'rejected' | 'revoked';
  conflictWith: string[];
  note: string;
  eventId: string;
  createdAt: number;
};

export type DisplayValue = {
  id: string;
  runId: string;
  panel: 'wrapped' | 'unwrapped' | 'quality' | 'cuts' | 'residuals' | 'height_chain';
  label: string;
  x?: number;
  y?: number;
  value: number | string | boolean | null;
  unit?: UnitName;
  coordinateBasis?: CoordinateBasis;
  status: 'current' | 'stale' | 'unknown' | 'rejected' | 'conflicted';
  provenance: ReferenceSet;
};

export type RunResult = {
  id: string;
  projectId: string;
  sequence: number;
  algorithmVersion: string;
  parameterFingerprint: string;
  seed: number;
  status: 'current' | 'stale';
  staleReason: string | null;
  createdAt: number;
  inputRefs: string[];
  scenarios: ScenarioKind[];
  qualityThreshold: Quantity<number>;
  components: Array<{ id: string; pixels: number; boundaryReason: string }>;
  edges: EdgeResult[];
  cycles: CycleResidual[];
  candidates: UnwrappedCandidate[];
  values: DisplayValue[];
  conversionChain: Array<{ id: string; formula: string; from: string; to: string; value: DisplayValue }>;
};

export type EventType =
  | 'project_imported'
  | 'parameter_revised'
  | 'source_patch_submitted'
  | 'candidate_run_completed'
  | 'local_decision_recorded'
  | 'local_lock_conflicted'
  | 'cut_edited'
  | 'result_marked_stale'
  | 'project_reset'
  | 'database_exported'
  | 'archive_imported';

export type EventRecord = {
  id: string;
  projectId: string;
  sequence: number;
  type: EventType;
  at: number;
  actor: 'importer' | 'reviewer' | 'phase_unwrap_engine' | 'system';
  summary: string;
  payload: Record<string, unknown>;
  references: string[];
  parentEventId: string | null;
};

export type Project = {
  id: string;
  name: string;
  scenario: ScenarioKind;
  casePackId: string;
  casePackVersion: string;
  createdAt: number;
  currentRunId: string | null;
};

export type EntityEnvelope<T> = {
  id: string;
  kind: string;
  entity: T;
  versionRefs: Array<{ ref: string; version: number | null; digest: string; summary: string }>;
  integrity: 'ok' | 'corrupt';
  integrityDiagnostics: string[];
};
