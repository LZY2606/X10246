export type ScenarioCode =
  | 'phase_boundary'
  | 'low_amplitude_hole'
  | 'multiconnected_region'
  | 'cycle_nonclosure'
  | 'wavelength_version_change'
  | 'integer_ambiguity'
  | 'local_lock_conflict';

export type SourceKind =
  | 'wrapped_phase_pixels'
  | 'amplitude_pixels'
  | 'snr_scores'
  | 'invalid_mask'
  | 'wavelength'
  | 'incidence_geometry'
  | 'calibration_surface'
  | 'cut_edit_history';

export type SourceRole = SourceKind | 'phase_tile' | 'composed_phase_canvas';

export type UnitSystem = {
  phase: 'radian';
  amplitude: 'adu' | 'normalized_amplitude';
  wavelength: 'nanometer' | 'micrometer' | 'millimeter';
  geometry: 'radian';
  calibrationLength: 'micrometer' | 'millimeter' | 'meter';
  height: 'nanometer' | 'micrometer' | 'millimeter';
};

export type CoordinateBasis = {
  coordinateSystem: 'pixel_index_top_left' | 'calibration_plane_xy';
  origin: [number, number];
  pixelPitch: { x: number; y: number; lengthUnit: UnitSystem['calibrationLength'] };
};

export type Quantity<T extends string> = {
  value: number | string;
  unit: T;
  rawText?: string;
  diagnostic?: string;
};

export type GridFragment<T> = {
  gridKind: 'grid';
  width: number;
  height: number;
  values: T[][];
  units: UnitSystem;
  coordinateBasis: CoordinateBasis;
  rawRepresentation: unknown;
};

export type TilePlacement = {
  tileFragmentId?: string;
  tileKey: string;
  at: [number, number];
};

export type ComposedPhaseCanvas = {
  gridKind: 'composed_phase_canvas';
  width: number;
  height: number;
  background: number | string;
  placements: TilePlacement[];
  units: UnitSystem;
  coordinateBasis: CoordinateBasis;
  rawRepresentation: unknown;
};

export type WrappedPhaseFragmentContent = GridFragment<number | string> | ComposedPhaseCanvas;
export type AmplitudeFragmentContent = GridFragment<number | string>;
export type SnrFragmentContent = GridFragment<number | string>;
export type MaskFragmentContent = GridFragment<boolean | 0 | 1 | '0' | '1' | 'true' | 'false'>;

export type WavelengthFragmentContent = {
  wavelength: Quantity<UnitSystem['wavelength']>;
  versionLabel: string;
  rawRepresentation: unknown;
};

export type IncidenceGeometryFragmentContent = {
  illuminationAngle: Quantity<UnitSystem['geometry']>;
  observationAngle: Quantity<UnitSystem['geometry']>;
  angleConvention: 'measured_from_surface_normal';
  rawRepresentation: unknown;
};

export type CalibrationSurfaceFragmentContent = {
  planeOrigin: { x: Quantity<'calibrationLength'>; y: Quantity<'calibrationLength'>; z: Quantity<'calibrationLength'> };
  xBasis: [number, number, number];
  yBasis: [number, number, number];
  zOffset: Quantity<'calibrationLength'>;
  lengthUnit: UnitSystem['calibrationLength'];
  rawRepresentation: unknown;
};

export type CutEdit = {
  editId: string;
  at: [number, number];
  to: [number, number];
  action: 'add_branch_cut' | 'remove_branch_cut';
  reason: string;
  editedAtLogical: string;
};

export type CutEditHistoryFragmentContent = {
  edits: CutEdit[];
  rawRepresentation: unknown;
};

export type RawFragmentContent =
  | ({ kind: 'wrapped_phase_pixels' } & WrappedPhaseFragmentContent)
  | ({ kind: 'amplitude_pixels' } & AmplitudeFragmentContent)
  | ({ kind: 'snr_scores' } & SnrFragmentContent)
  | ({ kind: 'invalid_mask' } & MaskFragmentContent)
  | ({ kind: 'wavelength' } & WavelengthFragmentContent)
  | ({ kind: 'incidence_geometry' } & IncidenceGeometryFragmentContent)
  | ({ kind: 'calibration_surface' } & CalibrationSurfaceFragmentContent)
  | ({ kind: 'cut_edit_history' } & CutEditHistoryFragmentContent);

export type VersionRef = {
  kind: string;
  id: string;
  version: number;
  digest: string;
  required: boolean;
};

export type DerivationKind =
  | 'quality_map'
  | 'cut_network'
  | 'cycle_residual_map'
  | 'unwrapping_tree_bundle'
  | 'height_surface';

export type AlgorithmVersion =
  | 'quality/2026-09-27.v1'
  | 'branch-cut/2026-09-27.v1'
  | 'cycle-residue/2026-09-27.v1'
  | 'unwrapping/2026-09-27.v1'
  | 'phase-to-height/2026-09-27.v1';

export type AnalysisParameters = {
  lowAmplitudeThreshold: { value: number; unit: 'adu' };
  lowSnrThreshold: { value: number; unit: 'snr' };
  maxTruePhaseStep: { value: number; unit: 'radian' };
  residueTolerance: { value: number; unit: 'radian' };
  preferredIntegerPenalty: { value: number; unit: 'cycle^-2' };
};

export type PixelStatus = 'valid' | 'invalid_mask' | 'low_amplitude' | 'low_snr' | 'unconvertible_phase';

export type QualityCell = {
  pixel: [number, number];
  status: PixelStatus;
  score: number | null;
  amplitude: number | null;
  snr: number | null;
  diagnostic: string | null;
};

export type IntegerCandidate = {
  candidateId: string;
  edgeId: string;
  integerOffsetCycles: number;
  wrappedStepRadian: number;
  trueStepRadian: number;
  legal: boolean;
  adoptedByTreeIds: string[];
  rejectReason: string | null;
};

export type CutEdge = {
  edgeId: string;
  from: [number, number];
  to: [number, number];
  cutClass: 'residue_pair' | 'unknown_region_boundary' | 'manual_edit';
  status: 'open_cut' | 'closed_in_tree' | 'crosses_unknown';
  integerCandidates: VersionRef[];
  selectedCandidateRef: VersionRef | null;
};

export type ResidueLoop = {
  loopId: string;
  pixels: [[number, number], [number, number], [number, number], [number, number]];
  wrappedSumRadian: number | null;
  cycleResidualRadian: number | null;
  charge: -1 | 0 | 1 | null;
  status: 'closed_nonzero' | 'closed_zero' | 'unknown_cell';
};

export type UnwrappingTree = {
  treeId: string;
  strategy: 'maximum_quality' | 'minimum_hop_alternative' | 'forced_integer_alternative';
  componentId: string;
  pathEdgeIds: string[];
  phaseByPixel: Record<string, number | null>;
  nonTreeCycleMismatches: { edgeId: string; mismatchRadian: number }[];
  locallyConsistent: boolean;
};

export type HeightCell = {
  pixel: [number, number];
  height: Quantity<'nanometer'> | null;
  candidateHeights: { treeId: string; height: Quantity<'nanometer'> }[];
  calibrationCoordinate: {
    x: Quantity<'calibrationLength'>;
    y: Quantity<'calibrationLength'>;
  };
  status: PixelStatus | 'integer_ambiguous' | 'unconverted_unit';
  sourceTreeId: string | null;
  diagnostic: string | null;
};

export type DerivationResult =
  | { kind: 'quality_map'; cells: QualityCell[][] }
  | { kind: 'cut_network'; edges: CutEdge[]; residues: ResidueLoop[] }
  | { kind: 'cycle_residual_map'; loops: ResidueLoop[] }
  | {
      kind: 'unwrapping_tree_bundle';
      trees: UnwrappingTree[];
      integerCandidates: IntegerCandidate[];
      components: { componentId: string; pixel: [number, number] }[];
    }
  | { kind: 'height_surface'; cells: HeightCell[][]; conversionChain: unknown };

export type Diagnostic = {
  code:
    | ScenarioCode
    | 'unconvertible_value_retained'
    | 'missing_required_source'
    | 'grid_dimension_mismatch'
    | 'unknown';
  severity: 'info' | 'warning' | 'error';
  message: string;
  pixel?: [number, number];
  sourceFragmentId?: string;
};

export type AnalysisBundle = {
  parameters: AnalysisParameters;
  quality: { kind: 'quality_map'; cells: QualityCell[][] };
  cuts: { kind: 'cut_network'; edges: CutEdge[]; residues: ResidueLoop[] };
  cycles: { kind: 'cycle_residual_map'; loops: ResidueLoop[] };
  unwrapping: {
    kind: 'unwrapping_tree_bundle';
    trees: UnwrappingTree[];
    integerCandidates: IntegerCandidate[];
    components: { componentId: string; pixel: [number, number] }[];
  };
  height: { kind: 'height_surface'; cells: HeightCell[][]; conversionChain: unknown };
  diagnostics: Diagnostic[];
};
