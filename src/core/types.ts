/**
 * Fringe Ledger — domain data contract.
 *
 * Vocabulary is taken directly from interferometric phase-unwrapping review:
 * wrapped phase pixels, amplitude, SNR score, validity mask, wavelength,
 * illumination geometry, calibration surface and branch-cut edit history.
 * Nothing here is flattened into generic name/value pairs.
 */

export type RawKind =
  | 'wrapped_phase'
  | 'amplitude'
  | 'snr_score'
  | 'validity_mask'
  | 'wavelength'
  | 'incidence_geometry'
  | 'calibration_surface'
  | 'cut_edit_history';

/** Immutable raw input kinds. Raw inputs are never overwritten after submit. */
export const RAW_KINDS: readonly RawKind[] = [
  'wrapped_phase',
  'amplitude',
  'snr_score',
  'validity_mask',
  'wavelength',
  'incidence_geometry',
  'calibration_surface',
  'cut_edit_history'
] as const;

/**
 * A physical quantity that keeps the representation it was imported with.
 * Normalisation happens only on derived layers; values that cannot be
 * converted stay at the source with a diagnostic instead of being dropped.
 */
export interface Quantity {
  value: number;
  /** Unit exactly as imported, e.g. "nm", "um", "deg", "rad". */
  unit: string;
  /** Reference frame for the number, e.g. "vacuum", "lab-coordinate". */
  basis: string;
}

/** Raster frame shared by 2-D inputs. */
export interface GridSpec {
  rows: number;
  cols: number;
  /** Pixel coordinates in the laboratory reference frame. */
  origin: { x: Quantity; y: Quantity };
  pixelPitch: { x: Quantity; y: Quantity };
}

/**
 * Compact raster: row-major values plus an inline validity bitmap for grids.
 * `nodata` entries are kept (never erased) and flagged; derived layers must
 * not invent phase in low-amplitude / invalid regions.
 */
export interface GridPayload {
  kind: RawKind;
  grid: GridSpec;
  values: number[];
  nodata: number[];
  /** Unit of the values ("rad", "count", dimensionless "1", ...). */
  unit: string;
  basis: string;
}

export interface WavelengthPayload {
  kind: 'wavelength';
  lambda: Quantity;
}

export interface IncidenceGeometryPayload {
  kind: 'incidence_geometry';
  /** Angle of illumination measured from surface normal. */
  incidenceAngle: Quantity;
  /** Phase-to-height sensitivity model identifier. */
  sensitivityModel: string;
}

export interface CalibrationSurfacePayload {
  kind: 'calibration_surface';
  /** Plane fit z = a*x + b*y + c, with units per basis. */
  plane: { a: number; b: number; c: number };
  planeUnit: { slope: string; intercept: string };
  /** Residual RMS of the fit, kept for provenance/diagnostics. */
  fitRms: Quantity;
  /** Frame ids of the calibration frames imported in the lab. */
  calibrationFrames: string[];
}

/** One human or tool edit of the branch-cut network. The whole list is versioned. */
export interface CutEdit {
  /** Stable id of the edited branch-cut edge ("r,c-r,c"). */
  edgeId: string;
  action: 'add' | 'remove' | 'force_offset';
  /** Explicit whole-cycle offset across the cut when action=force_offset. */
  integerOffsetCycles?: number;
  reason: string;
  actor: 'human' | 'algorithm';
}

export interface CutEditHistoryPayload {
  kind: 'cut_edit_history';
  edits: CutEdit[];
}

export type RawPayload =
  | GridPayload
  | WavelengthPayload
  | IncidenceGeometryPayload
  | CalibrationSurfacePayload
  | CutEditHistoryPayload;

// ---------------------------------------------------------------------------
// Identity & versioning
// ---------------------------------------------------------------------------

/** Content-addressed identity of an immutable piece of content. */
export interface ContentRef {
  /** sha256 over canonical JSON of the payload. */
  sha256: string;
  /** Byte length of the canonical JSON. */
  bytes: number;
}

export interface VersionMeta {
  /** Monotonic version number inside a kind lineage, starts at 1. */
  version: number;
  /** Parent raw version (null for the first version). */
  parentVersion: number | null;
  lineage: RawKind;
  ref: ContentRef;
  /** Virtual timestamp used by replay; no wall clock dependence. */
  recordedAt: number;
  submittedBy: string;
  /** Import note / change description. */
  note: string;
}

export interface RawVersion extends VersionMeta {
  payload: RawPayload;
}

export type ArtifactKind =
  | 'quality_map'
  | 'residue_map'
  | 'connected_regions'
  | 'branch_cut_network'
  | 'unwrapped_phase'
  | 'cycle_residual'
  | 'height_surface';

/** Fingerprint of the computation that produced an artifact. */
export interface AlgorithmFingerprint {
  algorithm: string;
  algorithmVersion: string;
  parameters: Record<string, unknown>;
  /** sha256 over canonical {algorithm, algorithmVersion, parameters}. */
  fingerprint: string;
}

export type ArtifactStatus =
  | 'current'
  | 'stale'
  | 'failed'
  | 'unknown';

export interface DerivedArtifact {
  id: string;
  kind: ArtifactKind;
  status: ArtifactStatus;
  algorithm: AlgorithmFingerprint;
  /** Explicit direct sources: raw versions, other artifacts, or decisions. */
  sources: SourceRef[];
  /** Content ref of the artifact payload itself. */
  ref: ContentRef;
  payload: unknown;
  createdAt: number;
  /** Set when status=failed: structured diagnosis, source value retained. */
  diagnostic?: Diagnostic;
  /** True when a newer transitive source makes this result no longer current. */
  stale: boolean;
  /** Id of the artifact that supersedes this one, if recomputed. */
  supersededBy: string | null;
}

export type SourceRefKind = 'raw_version' | 'artifact' | 'decision' | 'event';

export interface SourceRef {
  kind: SourceRefKind;
  /** Stable identity: raw "<lineage>@v<version>", artifact id, event id, ... */
  id: string;
  version?: number;
  /** sha256 recorded at derivation time. */
  sha256: string;
  /** Short human-readable content summary. */
  summary: string;
}

export interface Diagnostic {
  code:
    | 'LOW_AMPLITUDE_UNKNOWN'
    | 'UNRESOLVED_CYCLE'
    | 'UNCONVERTIBLE_UNIT'
    | 'MISSING_SOURCE'
    | 'MULTI_CONNECTED'
    | 'MULTI_VALUED_INTEGER'
    | 'LOCK_CONFLICT'
    | 'WAVELENGTH_VERSION_DRIFT'
    | 'FORMAT_ERROR'
    | 'CORRUPT_REFERENCE';
  message: string;
  /** Pixel/edge/region coordinates the diagnostic applies to. */
  locations: string[];
}

// ---------------------------------------------------------------------------
// Event log (append-only history; time travel restores these exact versions)
// ---------------------------------------------------------------------------

export type EventType =
  | 'RAW_INPUT_SUBMITTED'
  | 'INTERPRETATION_CREATED'
  | 'DERIVATION_RECORDED'
  | 'CANDIDATE_RECORDED'
  | 'CANDIDATE_REJECTED'
  | 'LOCK_DECIDED'
  | 'CONFLICT_DETECTED'
  | 'CONFLICT_RESOLVED'
  | 'CUT_EDITED'
  | 'ARTIFACT_STALE'
  | 'REVIEW_TIMELINE'
  | 'COUNTEREXAMPLE_JUDGMENT';

export interface HistoryEvent {
  id: string;
  seq: number;
  type: EventType;
  at: number;
  actor: string;
  payload: Record<string, unknown>;
  /** Every reference used when the event was recorded (no latest-version fallback). */
  references: SourceRef[];
  parentEventId: string | null;
}

// ---------------------------------------------------------------------------
// Unwrapping candidates, cuts, cycles, locks (first-class review entities)
// ---------------------------------------------------------------------------

export type IntegerCandidateStatus = 'proposed' | 'accepted' | 'rejected' | 'conflicting';

export interface IntegerCandidate {
  id: string;
  /** Edge ("r,c-r,c") or component ("region:<id>") the offset applies to. */
  target: string;
  targetType: 'cut_edge' | 'region';
  /** Legal whole-cycle (2*pi) offsets; >1 means the problem is multi-valued. */
  offsetCycles: number;
  status: IntegerCandidateStatus;
  /** Tree path of pixels used to produce this candidate. */
  treePath: string[];
  /** Residual of each cycle involved (fraction of a cycle at closure). */
  cycleResiduals: Record<string, number>;
  rejectReason?: string;
  sources: SourceRef[];
  createdAt: number;
}

export interface LockDecision {
  id: string;
  regionId: string;
  candidateId: string | null;
  /** Explicit locked integer offset when accepted; null when "unknown". */
  lockedOffsetCycles: number | null;
  decision: 'accept' | 'reject' | 'adjust';
  parameterAdjustments: Record<string, unknown>;
  note: string;
  actor: string;
  decidedAt: number;
  /** When the decision was later undone, this is set (decision is retained). */
  undoneAt: number | null;
  /** Conflict this decision resolves, if any. */
  resolvesConflictId: string | null;
  sources: SourceRef[];
}

export interface ConflictRecord {
  id: string;
  kind: 'integer_multivalue' | 'local_lock' | 'cycle_nonclosure' | 'wavelength_drift';
  status: 'open' | 'resolved';
  description: string;
  involvedCandidates: string[];
  involvedLocks: string[];
  detectedAt: number;
  resolvedAt: number | null;
  resolutionEventId: string | null;
}

// ---------------------------------------------------------------------------
// Provenance query result
// ---------------------------------------------------------------------------

export interface EntityView {
  id: string;
  kind: string;
  version: number | null;
  status: ArtifactStatus | 'raw' | 'decision' | 'candidate' | 'conflict' | 'event';
  summary: string;
  contentRef: ContentRef;
  /** Versions and content digests this entity references. Missing => corrupt. */
  references: SourceRef[];
  corrupted?: boolean;
  corruptionReason?: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Counterexample archive
// ---------------------------------------------------------------------------

/** The seven direct-source perturbations the archive is built around. */
export type ScenarioCode =
  | 'phase_boundary_crossing'
  | 'low_amplitude_holes'
  | 'multi_connected_regions'
  | 'cycle_nonclosure'
  | 'wavelength_version_change'
  | 'integer_multivalue'
  | 'local_lock_conflict';

export const SCENARIO_CODES: readonly ScenarioCode[] = [
  'phase_boundary_crossing',
  'low_amplitude_holes',
  'multi_connected_regions',
  'cycle_nonclosure',
  'wavelength_version_change',
  'integer_multivalue',
  'local_lock_conflict'
] as const;

/** Machine-readable judgment recorded for an archive input. */
export interface ArchiveJudgment {
  code: ScenarioCode;
  /** Domain rule the judgment is based on, in the lab's own vocabulary. */
  criterion:
    | 'NO_GUESS_IN_LOW_AMPLITUDE'
    | 'EXPLICIT_INTEGER_OFFSET_ACROSS_CUT'
    | 'KEEP_TREE_PATHS_AND_CYCLE_RESIDUALS'
    | 'LOCALIZED_BLAST_RADIUS'
    | 'ALL_LEGAL_CANDIDATES_RETAINED'
    | 'NO_LATEST_VERSION_FALLBACK';
  passed: boolean;
  detail: string;
  affectedObjects: string[];
  expectedObjects: string[];
}

export interface ArchiveInputRecord {
  id: string;
  scenario: ScenarioCode;
  role: 'minimal' | 'combined';
  /** Content-addressed fragments this input uses; shared fragments stored once. */
  fragmentRefs: ContentRef[];
  /** Independent interpretation version for this role. */
  interpretationVersion: number;
  interpretationNote: string;
  diagnostic: Diagnostic | null;
  adopted: boolean;
  /** Human decision kept independently for this input. */
  decision: {
    accepted: boolean;
    note: string;
    decidedAt: number;
  };
  judgmentEvents: string[];
}
