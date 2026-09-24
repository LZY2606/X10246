import type { CoordBasis, LengthUnit, PhaseUnit, Unit } from "./units.js";
import type { GridSpec } from "./grid.js";

export type EntityKind =
  | "WrappedPhaseFrame"
  | "AmplitudeFrame"
  | "QualityScoreFrame"
  | "InvalidMask"
  | "WavelengthSpec"
  | "IlluminationGeometry"
  | "CalibrationPlane"
  | "CutEditHistory"
  | "QualityMap"
  | "ResidueMap"
  | "BranchCutNetwork"
  | "UnwrapTree"
  | "CycleResidualSet"
  | "HeightChain"
  | "LocalLock";

export type InputKind = Extract<
  EntityKind,
  | "WrappedPhaseFrame"
  | "AmplitudeFrame"
  | "QualityScoreFrame"
  | "InvalidMask"
  | "WavelengthSpec"
  | "IlluminationGeometry"
  | "CalibrationPlane"
  | "CutEditHistory"
>;

export type DerivedKind = Exclude<EntityKind, InputKind>;

export interface ValueWithUnit {
  value: number;
  unit: Unit;
}

export interface CellDiagnostic {
  index: number;
  code:
    | "NON_NUMERIC_RAW"
    | "OUT_OF_PHASE_RANGE"
    | "UNCONVERTIBLE_UNIT"
    | "LOW_AMPLITUDE_HOLE"
    | "MASK_INVALID";
  rawRepresentation: string;
  message: string;
}

interface VersionedInputBase {
  entityId: string;
  version: number;
  parentVersion: number | null;
  createdAt: number;
  immutable: true;
}

export interface WrappedPhaseFrameV extends VersionedInputBase {
  kind: "WrappedPhaseFrame";
  grid: GridSpec;
  phaseUnit: PhaseUnit;
  rawTokens: string[];
  wrappedRadians: number[];
  diagnostics: CellDiagnostic[];
  blobId: string;
}

export interface AmplitudeFrameV extends VersionedInputBase {
  kind: "AmplitudeFrame";
  grid: GridSpec;
  amplitudeUnit: "adu" | "normalized";
  amplitudes: number[];
  rawTokens: string[];
  lowAmplitudeThreshold: number;
  diagnostics: CellDiagnostic[];
  blobId: string;
}

export interface QualityScoreFrameV extends VersionedInputBase {
  kind: "QualityScoreFrame";
  grid: GridSpec;
  scoreUnit: "snr_db" | "normalized";
  scores: number[];
  rawTokens: string[];
  diagnostics: CellDiagnostic[];
  blobId: string;
}

export interface InvalidMaskV extends VersionedInputBase {
  kind: "InvalidMask";
  grid: GridSpec;
  invalid: boolean[];
  rawTokens: string[];
  diagnostics: CellDiagnostic[];
  blobId: string;
}

export interface WavelengthSpecV extends VersionedInputBase {
  kind: "WavelengthSpec";
  wavelength: ValueWithUnit & { unit: LengthUnit };
  effectiveWavelengthM: number | null;
  diagnostic: CellDiagnostic | null;
}

export interface IlluminationGeometryV extends VersionedInputBase {
  kind: "IlluminationGeometry";
  incidenceAngle: { value: number; unit: "degree" | "radian" };
  sensitivityFactor: number;
  coordBasis: CoordBasis;
}

export interface CalibrationPlaneV extends VersionedInputBase {
  kind: "CalibrationPlane";
  grid: GridSpec;
  method: "flat_reference" | "tilted_plane";
  coefficientsM: { a: number; b: number; c: number };
  heightUnit: LengthUnit;
  coordBasis: CoordBasis;
  residualRmsM: number;
}

export interface CutEditRecord {
  editId: string;
  at: number;
  action: "add" | "remove" | "move";
  from?: [number, number];
  to?: [number, number];
  reason: string;
}

export interface CutEditHistoryV extends VersionedInputBase {
  kind: "CutEditHistory";
  edits: CutEditRecord[];
}

export type InputEntityVersion =
  | WrappedPhaseFrameV
  | AmplitudeFrameV
  | QualityScoreFrameV
  | InvalidMaskV
  | WavelengthSpecV
  | IlluminationGeometryV
  | CalibrationPlaneV
  | CutEditHistoryV;

export type ResidueCharge = 1 | -1;

export interface Residue {
  index: number;
  charge: ResidueCharge;
  wrappedSum: number;
  masked: boolean;
}

export interface QualityCell {
  index: number;
  quality: number;
  lowAmplitude: boolean;
  invalid: boolean;
  component: number;
}

export interface QualityMapV extends VersionedInputBase {
  kind: "QualityMap";
  grid: GridSpec;
  cells: QualityCell[];
  componentCount: number;
  algorithm: string;
  paramsFingerprint: string;
  sources: Ref[];
}

export interface ResidueMapV extends VersionedInputBase {
  kind: "ResidueMap";
  grid: GridSpec;
  residues: Residue[];
  boundaryCharge: number;
  algorithm: string;
  paramsFingerprint: string;
  sources: Ref[];
}

export interface CutEdge {
  a: number;
  b: number;
  kind: "residue_pair" | "residue_boundary";
  manual: boolean;
  editId?: string;
}

export interface BranchCutNetworkV extends VersionedInputBase {
  kind: "BranchCutNetwork";
  grid: GridSpec;
  edges: CutEdge[];
  blockedPairs: Array<[number, number]>;
  unpairedResidues: number[];
  sources: Ref[];
  algorithm: string;
  paramsFingerprint: string;
}

export interface TreeEdge {
  from: number;
  to: number;
  wrapIncrement: number;
  cutCrossed: boolean;
  cutEdge?: [number, number];
}

export interface CycleOrderCandidate {
  candidateId: string;
  orderOffsets: number[];
  scorePenalty: number;
  status: "legal" | "rejected";
  rejectionReason: string | null;
  cutSideDelta: number | null;
}

export interface UnwrapTreeV extends VersionedInputBase {
  kind: "UnwrapTree";
  grid: GridSpec;
  strategy: "quality_flood" | "shortest_jump_mst";
  region: number;
  edges: TreeEdge[];
  seedIndex: number;
  unwrappedRadians: number[];
  unknownIndices: number[];
  cutOrderDeltas: Array<{ edge: [number, number]; delta: number }>;
  candidates: CycleOrderCandidate[];
  sources: Ref[];
  algorithm: string;
  paramsFingerprint: string;
}

export type CycleStatus =
  | "closed"
  | "misclosure_local"
  | "misclosure_around_residue"
  | "unknown";

export interface CycleResidual {
  cycleId: string;
  pixelLoop: number[];
  wrapResidual: number;
  status: CycleStatus;
  crossesCut: boolean;
  enclosesResidues: number[];
  treeStrategy: string;
  path: Array<{ from: number; to: number; increment: number }>;
}

export interface CycleResidualSetV extends VersionedInputBase {
  kind: "CycleResidualSet";
  grid: GridSpec;
  cycles: CycleResidual[];
  sources: Ref[];
  algorithm: string;
  paramsFingerprint: string;
}

export interface HeightCell {
  index: number;
  phaseUnwrappedRad: number | null;
  calibratedHeightM: number | null;
  unknown: boolean;
  diagnostic: string | null;
}

export interface HeightChainV extends VersionedInputBase {
  kind: "HeightChain";
  grid: GridSpec;
  cells: HeightCell[];
  sensitivityFactor: number;
  wavelengthVersionRef: Ref;
  chain: Array<{
    step: "phase_delta" | "geometry_sensitivity" | "wavelength" | "calibration_plane";
    formula: string;
  }>;
  sources: Ref[];
  algorithm: string;
  paramsFingerprint: string;
  stale: boolean;
}

export interface LocalLockV extends VersionedInputBase {
  kind: "LocalLock";
  targetRef: Ref;
  region: { indices: number[] };
  interpretation: string;
  acceptedTreeStrategy: "quality_flood" | "shortest_jump_mst" | null;
  acceptedCandidateId: string | null;
  conflictsWith: Ref[];
  state: "tentative" | "locked" | "conflicted" | "released";
  note: string;
}

export interface Ref {
  entityId: string;
  version: number;
  role: string;
}

export type DerivedEntityVersion =
  | QualityMapV
  | ResidueMapV
  | BranchCutNetworkV
  | UnwrapTreeV
  | CycleResidualSetV
  | HeightChainV
  | LocalLockV;

export type AnyEntityVersion = InputEntityVersion | DerivedEntityVersion;
