/**
 * 仅追加事件模型。
 * - 原始输入一经提交不可覆盖；修订通过新版本 + 父版本关系表达。
 * - 每个事件携带 seq（全局顺序）、at（虚拟/真实时间）、作者、原因。
 * - 派生值都带算法版本、参数指纹与直接来源。
 * - 缺少引用必须报损坏，不能退回当前最新版。
 */
import type {
  AnalysisParams,
  HeightResult,
  UnwrapResult,
} from '../domain/analysis-types.ts';
import type { QualityField } from '../domain/analysis-types.ts';
import type { InputBundle, RawGrid } from '../domain/vocabulary.ts';

export type EventType =
  | 'project-created'
  | 'input-submitted'
  | 'parameter-revised'
  | 'source-patched'
  | 'analysis-produced'
  | 'candidate-adjudicated'
  | 'local-lock-set'
  | 'lock-conflict-detected'
  | 'lock-conflict-resolved'
  | 'decision-undone'
  | 'view-restored';

export interface EventEnvelope<T = unknown> {
  eventId: string;
  seq: number;
  projectId: string;
  type: EventType;
  at: string;
  actor: string;
  reason: string;
  payload: T;
  parentSeq: number | null;
}

export interface ProjectCreatedPayload {
  name: string;
  caseTag: string;
  seed: number;
}

export interface InputVersionPayload {
  /** 稳定内容身份（raw_<hash>），原始字节只存一份。 */
  rawContentId: string;
  inputKind:
    | 'bundle'
    | 'wrappedPhasePixels'
    | 'wavelength'
    | 'incidenceGeometry'
    | 'calibrationSurface'
    | 'cutEditHistory'
    | 'invalidMask';
  versionId: string;
  parentVersionId: string | null;
  immutable: true;
  label: string;
  contentDigest: string;
  bundle?: InputBundle;
}

export interface ParameterRevisedPayload {
  parameterSetId: string;
  parentParameterSetId: string;
  params: AnalysisParams;
  changed: (keyof AnalysisParams)[];
}

export interface SourcePatchedPayload {
  bundleVersionId: string;
  parentBundleVersionId: string;
  rawContentId: string;
  changedTileIds: string[];
  patchNote: string;
  bundle: InputBundle;
}

export interface AnalysisProducedPayload {
  analysisId: string;
  bundleVersionId: string;
  wavelengthVersionId: string;
  parameterSetId: string;
  quality: QualityField;
  unwrap: UnwrapResult;
  height: HeightResult;
}

export interface CandidateAdjudication {
  candidateId: string;
  edgeId: string;
  k: number | null;
  decision: 'accepted' | 'rejected';
  rationale: string;
}

export interface CandidateAdjudicatedPayload {
  analysisId: string;
  adjudications: CandidateAdjudication[];
}

export interface LocalLockSetPayload {
  analysisId: string;
  lockId: string;
  target: { kind: 'pixel' | 'edge' | 'component' | 'candidate'; id: string };
  lockedValue: { k: number | null; label: string };
  interpretation: string;
}

export interface LockConflictPayload {
  conflictId: string;
  existingLockId: string;
  incomingLockId: string;
  scope: string;
  detail: string;
  resolution?: { keptLockId: string; resolution: 'keep-existing' | 'replace'; note: string };
}

export interface DecisionUndonePayload {
  undoneEventSeq: number;
  undoneEventId: string;
  replacementNote: string;
}

export interface ViewRestoredPayload {
  restoreSeq: number;
  restoredEventId: string;
}

export type AnyEvent =
  | EventEnvelope<ProjectCreatedPayload>
  | EventEnvelope<InputVersionPayload>
  | EventEnvelope<ParameterRevisedPayload>
  | EventEnvelope<SourcePatchedPayload>
  | EventEnvelope<AnalysisProducedPayload>
  | EventEnvelope<CandidateAdjudicatedPayload>
  | EventEnvelope<LocalLockSetPayload>
  | EventEnvelope<LockConflictPayload>
  | EventEnvelope<DecisionUndonePayload>
  | EventEnvelope<ViewRestoredPayload>;

export interface StoredRawContent {
  rawContentId: string;
  kind: string;
  bytes: Uint8Array;
  mediaType: string;
  createdAt: string;
}

export interface LedgerSnapshot {
  projectId: string;
  name: string;
  caseTag: string;
  seed: number;
  seq: number;
  events: AnyEvent[];
  bundleVersions: { versionId: string; parentVersionId: string | null; rawContentId: string; bundle: InputBundle; grid: RawGrid; at: string }[];
  wavelengthVersions: { versionId: string; parentVersionId: string | null; valueNm: number; raw: string; at: string }[];
  parameterSets: { parameterSetId: string; parentParameterSetId: string; params: AnalysisParams; at: string }[];
  analyses: AnalysisRecord[];
  locks: LockRecord[];
  conflicts: ConflictRecord[];
  decisions: DecisionRecord[];
}

export interface AnalysisRecord {
  analysisId: string;
  eventSeq: number;
  bundleVersionId: string;
  wavelengthVersionId: string;
  parameterSetId: string;
  quality: QualityField;
  unwrap: UnwrapResult;
  height: HeightResult;
  /** 依赖版本指纹；任一直接来源修订则仅依赖它的分析过期。 */
  dependencyKey: string;
  stale: boolean;
  staleBecause: string | null;
  adjudications: CandidateAdjudication[];
}

export interface LockRecord {
  lockId: string;
  eventSeq: number;
  analysisId: string;
  target: LocalLockSetPayload['target'];
  k: number | null;
  label: string;
  interpretation: string;
  active: boolean;
  supersededByLockId: string | null;
}

export interface ConflictRecord {
  conflictId: string;
  eventSeq: number;
  existingLockId: string;
  incomingLockId: string;
  scope: string;
  detail: string;
  resolution: 'unresolved' | 'keep-existing' | 'replace';
  resolutionEventSeq: number | null;
}

export interface DecisionRecord {
  eventSeq: number;
  eventId: string;
  kind: 'adjudication' | 'lock' | 'conflict-resolution' | 'undo' | 'parameter' | 'patch' | 'view-restore';
  undone: boolean;
  undoneAtSeq: number | null;
  summary: string;
}
