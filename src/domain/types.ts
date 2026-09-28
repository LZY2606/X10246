export type ArtifactRole =
  | 'wrapped_phase_pixels'
  | 'amplitude_map'
  | 'signal_quality_scores'
  | 'invalid_mask'
  | 'wavelength'
  | 'illumination_geometry'
  | 'calibration_surface'
  | 'cut_edit_history';

export type ScenarioCode =
  | 'phase_branch_boundary'
  | 'low_amplitude_hole'
  | 'multiply_connected_region'
  | 'open_cycle'
  | 'wavelength_version_change'
  | 'integer_ambiguity'
  | 'local_lock_conflict';

export type CandidateStatus = 'adopted' | 'proposed' | 'rejected' | 'conflicted' | 'stale' | 'unknown';
export type ValueStatus = 'valid' | 'invalid' | 'unknown' | 'stale' | 'conflicted';

export interface Quantity {
  raw: unknown;
  unit: string;
  coordinateFrame: string;
  normalized?: unknown;
  conversionDiagnostics: ConversionDiagnostic[];
}

export interface ConversionDiagnostic {
  path: string;
  code: 'UNCONVERTIBLE_VALUE' | 'OUT_OF_DOMAIN' | 'MISSING_UNIT' | 'UNSUPPORTED_COORDINATE_FRAME';
  message: string;
  raw: unknown;
}

export interface ArtifactVersion {
  artifactId: string;
  version: number;
  contentId: string;
  parentContentId: string | null;
  role: ArtifactRole;
  quantity: Quantity;
  contentHash: string;
  sourceFragmentIds: string[];
  interpretationVersion: string;
  createdAt: string;
}

export interface VersionRef {
  entityKind: 'artifact' | 'run' | 'candidate' | 'event' | 'lock' | 'pixel' | 'edge' | 'cycle' | 'height';
  entityId: string;
  version: number | string;
  contentHash: string;
  role?: ArtifactRole;
  path?: string;
}

export interface Grid2D {
  rows: number;
  cols: number;
  values: number[];
  unit: string;
  coordinateFrame: string;
}

export interface BooleanGrid {
  rows: number;
  cols: number;
  values: boolean[];
  unit: 'boolean';
  coordinateFrame: string;
}

export interface WavelengthValue {
  rawValue: unknown;
  rawUnit: string;
  normalizedNanometers: number | null;
  coordinateFrame: string;
}

export interface IlluminationGeometryValue {
  incidenceAngle: number;
  incidenceAngleUnit: 'radian' | 'degree';
  azimuth: number;
  azimuthUnit: 'radian' | 'degree';
  coordinateFrame: string;
  normalizedCosIncidence: number;
}

export interface CalibrationSurfaceValue {
  model: 'plane_phase_bias';
  phaseBias: number;
  phaseBiasUnit: 'radian';
  heightBias: number;
  heightBiasUnit: 'nanometer';
  coordinateFrame: string;
}

export interface CutEdit {
  editId: string;
  edge: { rowA: number; colA: number; rowB: number; colB: number };
  explicitOffsetTurns: number | null;
  reason: string;
  editedAt: string;
  parentEditId: string | null;
}

export interface InterferometryFrameInput {
  scenarioId: string;
  interpretationVersion: string;
  wrappedPhase: Grid2D;
  amplitude: Grid2D;
  signalQuality: Grid2D;
  invalidMask: BooleanGrid;
  wavelength: WavelengthValue;
  illuminationGeometry: IlluminationGeometryValue;
  calibrationSurface: CalibrationSurfaceValue;
  cutEditHistory: {
    coordinateFrame: string;
    edits: CutEdit[];
  };
  fragmentBindings: Record<ArtifactRole, string[]>;
}

export interface UnwrapParameters {
  algorithmVersion: string;
  amplitudeThreshold: number;
  qualityThreshold: number;
  ambiguityWindowTurns: number;
  heightTransferFunction: 'four_step_reflection_normal_incidence';
  wavelengthContentId: string;
  geometryContentId: string;
  calibrationContentId: string;
  phaseContentId: string;
  maskContentId: string;
  amplitudeContentId: string;
  qualityContentId: string;
  cutHistoryContentId: string;
}

export interface PixelNode {
  pixelId: string;
  row: number;
  col: number;
  wrappedPhaseRad: number;
  amplitude: number;
  qualityScore: number;
  valid: boolean;
  componentId: string | null;
  refs: VersionRef[];
}

export interface PhaseGraphEdge {
  edgeId: string;
  fromPixelId: string;
  toPixelId: string;
  rowA: number;
  colA: number;
  rowB: number;
  colB: number;
  wrappedDeltaRad: number;
  nearestOffsetTurns: number;
  explicitOffsetTurns: number | null;
  selectedOffsetTurns: number | null;
  edgeKind: 'trusted' | 'low_amplitude' | 'cut' | 'mask_boundary';
  qualityScore: number;
  componentId: string | null;
  diagnostic: string | null;
  refs: VersionRef[];
}

export interface CycleResidual {
  cycleId: string;
  candidateId: string | null;
  anchorPixelId: string;
  edgeIds: string[];
  residualTurns: number | null;
  status: ValueStatus;
  diagnostic: string;
  refs: VersionRef[];
}

export interface UnwrappedPixelValue {
  valueId: string;
  candidateId: string;
  pixelId: string;
  row: number;
  col: number;
  unwrappedPhaseRad: number | null;
  relativeCalibrationPhaseRad: number | null;
  status: ValueStatus;
  refs: VersionRef[];
}

export interface HeightValue {
  heightId: string;
  candidateId: string;
  pixelId: string;
  row: number;
  col: number;
  heightNanometers: number | null;
  transferChain: Array<{
    step: string;
    stepVersion?: number | string;
    value: number | null;
    unit: string;
    sourceContentHash: string;
  }>;
  status: ValueStatus;
  diagnostic: string | null;
  refs: VersionRef[];
}

export interface UnwrappingCandidate {
  candidateId: string;
  candidateNumber: number;
  treeEdgeIds: string[];
  rootPixelId: string;
  status: CandidateStatus;
  statusReason: string;
  legalIntegerOffsets: Record<string, number[]>;
  rejectedEdgeIds: string[];
  cycleResiduals: CycleResidual[];
  pixels: UnwrappedPixelValue[];
  heights: HeightValue[];
  refs: VersionRef[];
}

export interface UnwrapRun {
  runId: string;
  parentRunId: string | null;
  scenarioId: string;
  parameters: UnwrapParameters;
  parameterFingerprint: string;
  status: 'current' | 'stale' | 'conflicted';
  pixels: PixelNode[];
  edges: PhaseGraphEdge[];
  candidates: UnwrappingCandidate[];
  diagnostics: string[];
  directSources: VersionRef[];
  createdAt: string;
}
