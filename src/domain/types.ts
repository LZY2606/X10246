export type SourceKind =
  | 'raw_phase_pixels'
  | 'signal_to_noise_scores'
  | 'invalid_pixel_mask'
  | 'wavelength'
  | 'incident_geometry'
  | 'calibration_surface'
  | 'cut_edit_history';

export type FeatureName =
  | 'phase_boundary_crossing'
  | 'low_amplitude_hole'
  | 'multiply_connected_region'
  | 'nonclosing_cycle'
  | 'wavelength_version_change'
  | 'integer_cycle_ambiguity'
  | 'local_lock_conflict';

export type MaterialStatus = 'accepted' | 'superseded' | 'retracted';
export type CandidateStatus = 'proposed' | 'accepted' | 'rejected' | 'conflicted' | 'stale';
export type LockStatus = 'proposed' | 'active' | 'conflicted' | 'resolved' | 'retracted';
export type EventType =
  | 'source_committed'
  | 'source_superseded'
  | 'derivation_completed'
  | 'candidate_proposed'
  | 'candidate_accepted'
  | 'candidate_rejected'
  | 'lock_proposed'
  | 'lock_conflicted'
  | 'lock_resolved'
  | 'parameter_revision'
  | 'invalid_reference_detected';

export interface UnitValue {
  readonly rawText: string;
  readonly unit: string;
  readonly value: number | null;
  readonly diagnostic?: string;
}

export interface CoordinateDatum {
  readonly id: string;
  readonly axes: readonly ['x', 'y', 'z'];
  readonly lengthUnit: string;
  readonly convention: string;
}

export interface PixelScalar {
  readonly x: number;
  readonly y: number;
  readonly rawText: string;
  readonly unit: 'radian' | 'dimensionless_SNR_dB';
  readonly value: number | null;
  readonly diagnostic?: string;
}

export interface RawPhaseMaterial {
  readonly kind: 'raw_phase_pixels';
  readonly width: number;
  readonly height: number;
  readonly pixels: readonly PixelScalar[];
  readonly coordinateDatum: CoordinateDatum;
}

export interface ScoreMaterial {
  readonly kind: 'signal_to_noise_scores';
  readonly width: number;
  readonly height: number;
  readonly pixels: readonly PixelScalar[];
}

export interface MaskMaterial {
  readonly kind: 'invalid_pixel_mask';
  readonly width: number;
  readonly height: number;
  readonly invalid: Readonly<Record<string, boolean>>;
  readonly rawRepresentation: readonly string[];
}

export interface WavelengthMaterial {
  readonly kind: 'wavelength';
  readonly wavelength: UnitValue;
  readonly source: string;
}

export interface IncidentGeometryMaterial {
  readonly kind: 'incident_geometry';
  readonly incidenceAngle: UnitValue;
  readonly sensitivityVector: readonly [number, number, number];
  readonly coordinateDatum: CoordinateDatum;
}

export interface CalibrationSurfaceMaterial {
  readonly kind: 'calibration_surface';
  readonly rawEquation: string;
  readonly zOffset: UnitValue;
  readonly coordinateDatum: CoordinateDatum;
}

export interface CutEdit {
  readonly editId: string;
  readonly edgeId: string;
  readonly action: 'cut' | 'uncut';
  readonly reason: string;
}

export interface CutHistoryMaterial {
  readonly kind: 'cut_edit_history';
  readonly edits: readonly CutEdit[];
}

export type SourceMaterial =
  | RawPhaseMaterial
  | ScoreMaterial
  | MaskMaterial
  | WavelengthMaterial
  | IncidentGeometryMaterial
  | CalibrationSurfaceMaterial
  | CutHistoryMaterial;

export interface SourceVersionInput {
  readonly materialId: string;
  readonly kind: SourceKind;
  readonly versionNumber: number;
  readonly parentVersionId?: string;
  readonly label: string;
  readonly createdAt: string;
  readonly material: SourceMaterial;
}

export interface SourceVersion extends SourceVersionInput {
  readonly versionId: string;
  readonly contentDigest: string;
  readonly status: MaterialStatus;
}

export interface VersionRef {
  readonly kind: SourceKind;
  readonly materialId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly contentDigest: string;
}

export interface DerivationInput {
  readonly derivationId: string;
  readonly algorithmName: string;
  readonly algorithmVersion: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly parameterFingerprint: string;
  readonly directSources: readonly VersionRef[];
  readonly createdAt: string;
  readonly virtualClock: string;
}

export interface EdgeRecord {
  readonly edgeId: string;
  readonly from: string;
  readonly to: string;
  readonly wrappedDifferenceRadians: number;
  readonly proposedIntegerOffsets: readonly number[];
  readonly selectedIntegerOffset: number | null;
  readonly isBranchCut: boolean;
  readonly cutReason: string | null;
  readonly qualityScoreDb: number | null;
}

export interface CycleRecord {
  readonly cycleId: string;
  readonly pixelIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly residualRadians: number;
  readonly residualCycles: number;
  readonly closed: boolean;
  readonly explanation: string;
}

export interface ComponentRecord {
  readonly componentId: string;
  readonly pixelIds: readonly string[];
  readonly internallyConsistent: boolean;
}

export interface UnwrapCandidate {
  readonly candidateId: string;
  readonly feature: FeatureName;
  readonly treeId: string;
  readonly status: CandidateStatus;
  readonly componentId: string;
  readonly anchorPixelId: string;
  readonly pixelOffsets: Readonly<Record<string, number>>;
  readonly path: readonly string[];
  readonly usedEdges: readonly string[];
  readonly rejectedReason: string | null;
  readonly ambiguityNote: string | null;
}

export interface HeightPoint {
  readonly pixelId: string;
  readonly x: number;
  readonly y: number;
  readonly unwrappedPhaseRadians: number | null;
  readonly height: UnitValue | null;
  readonly unknownReason: string | null;
}

export interface UnwrapResult {
  readonly feature: FeatureName;
  readonly edges: readonly EdgeRecord[];
  readonly cycles: readonly CycleRecord[];
  readonly components: readonly ComponentRecord[];
  readonly candidates: readonly UnwrapCandidate[];
}

export interface HeightResult {
  readonly feature: FeatureName;
  readonly points: readonly HeightPoint[];
  readonly chain: readonly string[];
}

export interface DerivationResult {
  readonly qualityMap?: Readonly<Record<string, number>>;
  readonly unwrap: UnwrapResult;
  readonly height?: HeightResult;
  readonly diagnostics: readonly string[];
}

export interface StoredDerivation extends DerivationInput {
  readonly rowId: number;
  readonly resultDigest: string;
  readonly result: DerivationResult;
  readonly current: boolean;
}

export interface ReviewLockInput {
  readonly lockId: string;
  readonly scope: string;
  readonly pixelId: string;
  readonly candidateId: string;
  readonly integerOffset: number;
  readonly rationale: string;
  readonly createdAt: string;
}

export interface ReviewLock extends ReviewLockInput {
  readonly status: LockStatus;
  readonly conflictsWith: readonly string[];
}

export interface AuditEvent {
  readonly eventId: string;
  readonly eventType: EventType;
  readonly clock: string;
  readonly actor: string;
  readonly subjectId: string;
  readonly summary: string;
  readonly refs: readonly VersionRef[];
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface EntitySnapshot {
  readonly entityId: string;
  readonly entityKind: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly contentDigest: string;
  readonly summary: string;
  readonly directSources: readonly VersionRef[];
}
