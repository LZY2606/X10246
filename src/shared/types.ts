/**
 * Domain vocabulary for the Fringe Ledger:
 * wrapped phase, amplitude / reliability (SNR) scores, invalidity masks,
 * wavelengths, illumination geometry, calibration planes, branch-cut edits,
 * quality maps, residue charges, cut networks, unwrap trees, loop residuals,
 * integer candidates and height conversion.
 *
 * Everything that can be displayed carries a stable identity; nothing is
 * reduced to generic name/value pairs.
 */

export type ID = string;
export type Sha256 = string;

/** Virtual clock + deterministic RNG context (tests inject fixed time/seed). */
export interface ClockRng {
  now(): number;
  next(): number;
}

/** Row/column coordinate in a frame, origin at top-left (pixel index basis). */
export interface Cell {
  r: number;
  c: number;
}

export interface GridDims {
  rows: number;
  cols: number;
}

/**
 * A physical quantity that keeps the original textual representation it was
 * imported with. Derived layers normalise via `siValue`; values that cannot be
 * converted stay at their origin with a diagnostic instead of being dropped.
 */
export interface Scalar {
  value: string;
  unit: string;
  siValue?: number;
  basis?: string;
  diagnostics: string[];
}

// ---------------------------------------------------------------------------
// Immutable raw inputs (never overwritten; revisions are new versions)
// ---------------------------------------------------------------------------

export type RawKind =
  | "wrapped_phase"
  | "amplitude"
  | "invalidity_mask"
  | "wavelength"
  | "illumination_geometry"
  | "calibration_plane"
  | "cut_edit_history";

export interface RawEnvelope {
  kind: RawKind;
  body: RawBody;
  sourceText: string;
}

export type RawBody =
  | WrappedPhaseFrame
  | AmplitudeFrame
  | InvalidityMask
  | WavelengthSpec
  | IlluminationGeometry
  | CalibrationPlane
  | CutEditHistory;

/** Original wrapped phase pixels, radians in (-pi, pi] (normalised in derived layer only). */
export interface WrappedPhaseFrame {
  dims: GridDims;
  unit: "rad";
  coordinateBasis: "pixel#top-left";
  /** row-major, one textual token per pixel; "" allowed only where mask invalid. */
  values: string[];
}

/** Amplitude / intensity frame. */
export interface AmplitudeFrame {
  dims: GridDims;
  unit: string; // e.g. "count", "a.u."
  coordinateBasis: "pixel#top-left";
  values: string[];
}

/** Operator-provided invalid mask (1 = invalid / no usable fringe signal). */
export interface InvalidityMask {
  dims: GridDims;
  coordinateBasis: "pixel#top-left";
  values: number[]; // 0 | 1
}

export interface WavelengthSpec {
  wavelength: Scalar;
  /** Revision label of the rule set used to interpret the source value. */
  specVersion: string;
}

export interface IlluminationGeometry {
  incidenceAngle: Scalar;
  azimuthAngle: Scalar;
  /** Sensitivity vector basis, e.g. "optical-axis#z". */
  vectorBasis: string;
}

export interface CalibrationPlane {
  /** Height of the reference plane at origin, SI when convertible. */
  z0: Scalar;
  /** Plane tilts, unit: "1" (height per pixel) with pixel-pitch basis. */
  slopeR: Scalar;
  slopeC: Scalar;
  pixelPitch: Scalar;
  basis: string;
}

/** Append-only stream of branch-cut edits; the stream itself is an immutable raw entity. */
export interface CutEdit {
  editId: string;
  at: number;
  action: "place" | "remove";
  /** Axis-aligned grid edge a cut is placed on. */
  edge: { a: Cell; b: Cell };
  /** Explicit integer-cycle offset enforced across the cut, if any. */
  cycleOffset?: number;
  reason: string;
  operator: string;
}

export interface CutEditHistory {
  edits: CutEdit[];
}

// ---------------------------------------------------------------------------
// Derived entities (algorithm version + parameter fingerprint + provenance)
// ---------------------------------------------------------------------------

export type DerivedKind =
  | "quality_map"
  | "residue_map"
  | "cut_network"
  | "unwrap_tree"
  | "loop_residuals"
  | "integer_candidate_set"
  | "height_surface"
  | "interpretation_lock";

export interface DerivedEnvelope {
  kind: DerivedKind;
  algorithmVersion: string;
  parameterFingerprint: Sha256;
  /** Direct sources (raw content IDs or other derived content IDs). */
  sources: ID[];
  status: "current" | "stale" | "superseded";
  supersededBy?: ID;
  body: DerivedBody;
}

export type DerivedBody =
  | QualityMap
  | ResidueMap
  | CutNetwork
  | UnwrapResult
  | LoopResiduals
  | IntegerCandidateSet
  | HeightSurface
  | InterpretationLock;

/** Per-pixel SNR/reliability score in [0,1]; low-amplitude pixels are never guessed. */
export interface QualityMap {
  dims: GridDims;
  scores: number[];
  /** True where amplitude is too low to infer phase: phase must remain unknown. */
  lowAmplitude: boolean[];
  masked: boolean[];
  threshold: number;
}

/** Residue charge of each 2x2 elementary loop: +1, -1, or 0. */
export interface ResidueMap {
  dims: GridDims; // charge grid has (rows-1) x (cols-1), dims here are frame dims
  charges: number[]; // length (rows-1)*(cols-1), row-major over top-left cells
  positive: Cell[];
  negative: Cell[];
}

/** A branch cut is a grid edge with an explicit whole-cycle jump. */
export interface CutLink {
  id: string;
  a: Cell;
  b: Cell;
  /** Integer-cycle offset carried across the cut (explicit, never implicit). */
  cycleOffset: number;
  origin: "residue_pairing" | "operator_edit";
}

export interface CutNetwork {
  dims: GridDims;
  cuts: CutLink[];
  /** Residues left unbalanced (e.g. multiply-connected boundaries). */
  unpairedResidues: Cell[];
}

export interface TreeEdge {
  a: Cell;
  b: Cell;
  /** Wrapped gradient in cycles, principal value in (-0.5, 0.5]. */
  wrappedCycles: number;
  /** Integer k applied when crossing this edge. */
  k: number;
  cut: boolean;
  known: boolean;
}

export interface UnwrapTree {
  dims: GridDims;
  /** Unwrapped phase in radians per cell; null where unknown (mask / low amplitude). */
  phaseRad: (number | null)[];
  /** Absolute integer order per cell; null where unknown. */
  order: (number | null)[];
  edges: TreeEdge[];
  /** BFS parent pointer ("r:c" -> "r:c"), documenting the actual path taken. */
  parent: Record<string, string | null>;
  rootCell: Cell;
  rootSeed: number;
  known: boolean[];
  /** Cells reachable as one internally consistent component of the cut graph. */
  components: string[][];
}

export type UnwrapResult = UnwrapTree;

export interface LoopCheck {
  id: string;
  cells: Cell[]; // closed loop of cells (last connects back to first)
  /** Sum of wrapped gradients around the loop in cycles. */
  wrappedSum: number;
  /** Net integer order change around the loop. */
  cycleResidual: number;
  closed: boolean;
  /** Residue charge enclosed by this loop (+/-1 / 0 when elementary). */
  enclosedCharge: number;
}

export interface LoopResiduals {
  dims: GridDims;
  loops: LoopCheck[];
  nonClosingLoopIds: string[];
}

/** A legal whole-cycle assignment for an edge or component; ambiguity is first class. */
export interface IntegerCandidate {
  id: string;
  scope: "edge" | "component" | "seed";
  target: string; // edge id or component id / cell token
  k: number;
  adopted: boolean;
  rejectReason?: string;
  note: string;
}

export interface IntegerCandidateSet {
  dims: GridDims;
  candidates: IntegerCandidate[];
  /** True when more than one legal candidate exists and none has been adopted. */
  ambiguous: boolean;
}

export interface HeightCell {
  cell: Cell;
  /** SI height in metres when convertible; null keeps the unknown state. */
  heightM: number | null;
  phaseRad: number | null;
  order: number | null;
  unknown: boolean;
  diagnostic?: string;
}

export interface HeightSurface {
  dims: GridDims;
  unit: "m";
  coordinateBasis: "pixel#top-left";
  cells: HeightCell[];
  wavelengthContentId?: ID;
  geometryContentId?: ID;
  calibrationContentId?: ID;
}

export type LockStatus = "locked" | "released" | "conflict";

export interface InterpretationLock {
  id: string;
  scope: Cell[] | { component: string };
  lockedCandidateId: string;
  status: LockStatus;
  reason: string;
  /** Conflicting lock id, when status === "conflict". */
  conflictWith?: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Event log (tamper-evident, append-only; order and hashes survive export)
// ---------------------------------------------------------------------------

export type EventType =
  | "project_created"
  | "raw_imported"
  | "import_rejected"
  | "raw_revised"
  | "quality_computed"
  | "residues_computed"
  | "cuts_computed"
  | "cut_edited"
  | "unwrap_computed"
  | "loops_computed"
  | "candidates_computed"
  | "heights_computed"
  | "interpretation_locked"
  | "lock_conflict"
  | "candidate_adopted"
  | "candidate_rejected"
  | "derived_invalidated"
  | "rule_revised"
  | "source_amended"
  | "archive_judgement";

export interface Event {
  seq: number;
  id: ID;
  type: EventType;
  at: number;
  actor: string;
  /** Direct sources this event is based on (content IDs / derived IDs). */
  sources: ID[];
  payload: Record<string, unknown>;
  /** Hash of the canonical payload bytes plus direct sources. */
  payloadHash: Sha256;
  /** Hash chain: hash(prevHash | this payloadHash | seq). */
  prevHash: Sha256;
  hash: Sha256;
}

export interface VersionRef {
  id: ID;
  version: number;
  parentId?: ID;
  contentHash: Sha256;
  contentSummary: string;
}

export interface Provenance {
  ref: VersionRef;
  directSources: VersionRef[];
}

export class CorruptedReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptedReferenceError";
  }
}

export class FormatError extends Error {
  diagnostics: string[];
  constructor(message: string, diagnostics: string[] = []) {
    super(message);
    this.name = "FormatError";
    this.diagnostics = diagnostics;
  }
}
