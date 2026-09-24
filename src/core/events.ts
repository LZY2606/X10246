/** 机器可读事件：判断依据、决定、冲突、过期全部落成事件。 */
import type { InputKind, ScenarioKind, DecisionRule } from "../domain/types";

export type EventType =
  | "input.imported"
  | "input.revised"
  | "baseline.verified"
  | "scenario.triggered"
  | "unwrap.completed"
  | "height.completed"
  | "candidate.adopted"
  | "candidate.rejected"
  | "params.adjusted"
  | "lock.acquired"
  | "lock.conflict"
  | "lock.released"
  | "decision.undone"
  | "result.expired"
  | "diagnostic.raised"
  | "archive.sealed"
  | "export.created"
  | "import.completed";

export interface DomainEvent<T = unknown> {
  seq: number;
  eventId: string;
  type: EventType;
  at: string;
  payload: T;
}

export interface InputImportedPayload {
  entityId: string;
  kind: InputKind;
  versionNo: number;
  digest: string;
  note?: string;
}
export interface InputRevisedPayload extends InputImportedPayload {
  parentVersionNo: number;
}
export interface ScenarioTriggeredPayload {
  scenario: ScenarioKind;
  affectedEntities: string[];
  inputFragments: string[];
}
export interface UnwrapCompletedPayload {
  resultId: string;
  algorithmVersion: string;
  paramFingerprint: string;
  sources: Array<{ entityId: string; versionNo: number; digest: string }>;
  candidateIds: string[];
  holeCount: number;
  cutCount: number;
  cycleCount: number;
}
export interface CandidateDecisionPayload {
  decisionId: string;
  resultId: string;
  candidateId: string;
  reason: string;
  rules: DecisionRule[];
}
export interface LockPayload {
  lockId: string;
  region: number[];
  owner: string;
  candidateId: string;
  conflictsWith?: string;
}
export interface ResultExpiredPayload {
  resultId: string;
  becauseOf: { entityId: string; versionNo: number };
}
export interface DiagnosticPayload {
  code: string;
  message: string;
  related: string[];
}
export interface UndoPayload {
  undoneEventSeq: number;
  reason: string;
}
