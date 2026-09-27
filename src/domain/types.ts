export type DomainUnit =
  | 'radian'
  | 'cycle'
  | 'nanometer'
  | 'millimeter'
  | 'pixel-index'
  | 'dimensionless'
  | 'radian-per-cycle';

export type DomainQuantity = {
  value: number;
  unit: DomainUnit;
  originalRepresentation: string;
};

export type CoordinateFrame = {
  frameId: string;
  basis: 'sensor-pixel-right-down-depth' | string;
  origin: [number, number, number];
  axes: [[number, number, number], [number, number, number], [number, number, number]];
  lengthUnit: 'nanometer' | 'millimeter';
};

export type Grid = {
  width: number;
  height: number;
  columnUnit: 'pixel-index';
  rowUnit: 'pixel-index';
  coordinateFrameId: string;
};

export type VersionRef = {
  entityId: string;
  version: number;
  kind: string;
  contentHash: string;
};

export type OriginalWrappedPhase = {
  kind: 'wrapped-phase-pixels';
  grid: Grid;
  values: number[];
  valueUnit: 'radian';
  range: '[-pi,+pi)';
  notes: string;
};

export type SignalQualityScore = {
  kind: 'signal-quality-scores';
  grid: Grid;
  values: number[];
  valueUnit: 'dimensionless';
  scale: '[0,1]';
  notes: string;
};

export type InvalidMask = {
  kind: 'invalid-mask';
  grid: Grid;
  invalid: boolean[];
  valueUnit: 'dimensionless';
  notes: string;
};

export type Wavelength = {
  kind: 'wavelength';
  value: DomainQuantity;
  stable: boolean;
  notes: string;
};

export type IncidentGeometry = {
  kind: 'incident-geometry';
  coordinateFrameId: string;
  illuminationDirection: [number, number, number];
  observationDirection: [number, number, number];
  illuminationAngle: DomainQuantity;
  notes: string;
};

export type CalibrationPlane = {
  kind: 'calibration-plane';
  coordinateFrameId: string;
  constant: DomainQuantity;
  xCoefficient: DomainQuantity;
  yCoefficient: DomainQuantity;
  valid: boolean;
  diagnostics: string[];
  notes: string;
};

export type CutEdit = {
  editId: string;
  at: string;
  action: 'add-cut' | 'remove-cut' | 'confirm-cut';
  edgeId: string;
  actor: string;
  rationale: string;
};

export type CutEditHistory = {
  kind: 'cut-edit-history';
  grid: Grid;
  edits: CutEdit[];
  notes: string;
};

export type UnwrapParameters = {
  kind: 'unwrap-parameters';
  algorithmVersion: string;
  seed: number;
  lowAmplitudeThreshold: number;
  allowedIntegerCycles: number[];
  heightTransferMode: 'reflection-normal-incidence';
  notes: string;
};

export type ImmutableInputContent =
  | OriginalWrappedPhase
  | SignalQualityScore
  | InvalidMask
  | Wavelength
  | IncidentGeometry
  | CalibrationPlane
  | CutEditHistory
  | UnwrapParameters;

export type PixelIdentity = {
  pixelId: string;
  row: number;
  column: number;
};

export type QualityPixel = PixelIdentity & {
  quality: number;
  invalid: boolean;
  lowAmplitude: boolean;
  sourceWrappedPhase: VersionRef;
  sourceAmplitude: VersionRef;
  sourceMask: VersionRef;
};

export type Residue = PixelIdentity & {
  residueId: string;
  chargeCycles: number;
  plaquetteCycle: [string, string, string, string];
};

export type CutEdge = {
  edgeId: string;
  a: PixelIdentity;
  b: PixelIdentity;
  crossCut: boolean;
  residuePath: boolean;
  sourceEditRef?: VersionRef;
};

export type CutNetworkResult = {
  kind: 'cut-network-result';
  residues: Residue[];
  edges: CutEdge[];
  components: Array<{ componentId: string; pixelIds: string[] }>;
  diagnostics: string[];
};

export type CycleResidual = {
  cycleId: string;
  cycleType: 'fundamental-cycle' | 'residue-plaquette';
  edgeIds: string[];
  pixelIds: string[];
  residualCycles: number | null;
  closureStatus: 'closed' | 'non-closed' | 'unknown';
  unknownReason?: string;
};

export type IntegerOffset = {
  edgeId: string;
  leftPixelId: string;
  rightPixelId: string;
  offsetCycles: number;
  explicit: true;
};

export type UnwrapCandidate = {
  candidateId: string;
  treeId: string;
  status: 'legal' | 'rejected' | 'unknown';
  componentOffsetsCycles: Record<string, number>;
  cutEdgeOffsets: IntegerOffset[];
  unwrappedRadians: Record<string, number | null>;
  integrationPath: Array<{ fromPixelId: string; toPixelId: string; edgeId: string }>;
  cycleResiduals: Array<{ cycleId: string; residualCycles: number | null; closureStatus: CycleResidual['closureStatus'] }>;
  unknownPixels: Array<{ pixelId: string; reason: 'INVALID_MASK' | 'LOW_AMPLITUDE_NO_PHASE_GUESS' }>;
  rejectedReasons: string[];
};

export type UnwrapCandidateSetResult = {
  kind: 'unwrap-candidate-set-result';
  candidates: UnwrapCandidate[];
  trees: Array<{ treeId: string; strategy: string; roots: string[]; edges: Array<{ edgeId: string; parentPixelId: string; childPixelId: string }> }>;
  selectedCandidateId?: string;
};

export type HeightPixel = PixelIdentity & {
  heightId: string;
  phaseRadians: number | null;
  calibrationResidualNanometers: number | null;
  surfaceHeightNanometers: number | null;
  wavelengthRef: VersionRef;
  geometryRef: VersionRef;
  calibrationRef: VersionRef;
  unknownReason?: string;
  conversionChainId: string;
};

export type HeightConversionChainResult = {
  kind: 'height-conversion-chain-result';
  chainId: string;
  formula: 'height_nm = (unwrapped_phase_rad - calibration_plane_phase) * wavelength_nm / (4*pi)';
  pixels: HeightPixel[];
  diagnostics: string[];
};

export type ResultContent =
  | { kind: 'quality-map-result'; pixels: QualityPixel[]; diagnostics: string[] }
  | CutNetworkResult
  | UnwrapCandidateSetResult
  | { kind: 'cycle-residual-result'; cycles: CycleResidual[]; diagnostics: string[] }
  | HeightConversionChainResult;

export type DerivedResult<T extends ResultContent = ResultContent> = {
  resultId: string;
  resultType: T['kind'];
  algorithmVersion: string;
  parameterFingerprint: string;
  sourceRefs: VersionRef[];
  candidateSourceResultId?: string;
  status: 'current' | 'superseded';
  content: T;
};

export type MachineRuleEvent =
  | 'PHASE_WRAP_BOUNDARY'
  | 'LOW_AMPLITUDE_HOLE'
  | 'MULTIPLE_CONNECTED_COMPONENTS'
  | 'CYCLE_NON_CLOSURE'
  | 'WAVELENGTH_VERSION_CHANGE'
  | 'INTEGER_MULTIPLE_SOLUTIONS'
  | 'LOCAL_LOCK_CONFLICT'
  | 'LOW_AMPLITUDE_NO_PHASE_GUESS'
  | 'BRANCH_CUT_OFFSET_EXPLICIT'
  | 'MULTIPLE_TREES_LOCAL_CONSISTENCY';

export type ScenarioId =
  | 'phase-wrap-boundary'
  | 'low-amplitude-hole'
  | 'multi-connected-region'
  | 'cycle-nonclosure'
  | 'wavelength-version-change'
  | 'integer-multiplicity'
  | 'local-lock-conflict';

export type ReviewDecision = {
  decisionId: string;
  eventId: string;
  candidateId: string;
  regionId: string;
  action: 'accept' | 'reject' | 'adjust' | 'undo';
  status: 'active' | 'conflicted' | 'undone';
  actor: string;
  rationale: string;
  targetDecisionId?: string;
  createdEventId: string;
};
