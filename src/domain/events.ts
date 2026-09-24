import type { Ref } from "./entities.js";

export type SituationCode =
  | "phase_boundary_crossing"
  | "low_amplitude_hole"
  | "multi_component"
  | "cycle_misclosure"
  | "wavelength_version_change"
  | "integer_ambiguity"
  | "local_lock_conflict";

export const SITUATION_CODES: SituationCode[] = [
  "phase_boundary_crossing",
  "low_amplitude_hole",
  "multi_component",
  "cycle_misclosure",
  "wavelength_version_change",
  "integer_ambiguity",
  "local_lock_conflict"
];

export type EventType =
  | "input.imported"
  | "input.revised"
  | "input.reformat_rejected"
  | "derived.computed"
  | "derived.stale"
  | "candidate.proposed"
  | "candidate.adopted"
  | "candidate.rejected"
  | "cut.edited"
  | "local.locked"
  | "local.conflict"
  | "local.released"
  | "decision.accepted"
  | "decision.rejected"
  | "decision.params_adjusted"
  | "decision.undone"
  | "wavelength.version_changed"
  | "situation.replayed"
  | "archive.exported"
  | "archive.imported"
  | "corruption.detected";

export interface RationaleFact {
  code:
    | "LOW_AMPLITUDE_NO_GUESS"
    | "CUT_SIDE_OFFSET_EXPLICIT"
    | "TREE_LOCAL_CONSISTENCY"
    | "PATH_AND_CYCLE_RESIDUAL_RETAINED"
    | "ALL_LEGAL_CANDIDATES_RETAINED"
    | "MISSING_REF_IS_CORRUPT"
    | "STALE_NOT_CURRENT"
    | "RAW_IMMUTABLE";
  subject: string;
  detail: Record<string, unknown>;
}

export interface ReviewEvent {
  eventId: string;
  seq: number;
  type: EventType;
  at: number;
  actor: "operator" | "system" | "importer";
  situation: SituationCode | null;
  runId: string | null;
  subject: Ref | null;
  affected: Ref[];
  rationale: RationaleFact[];
  note: string;
  parameters: Record<string, unknown>;
}

export function refKey(ref: Ref): string {
  return `${ref.entityId}@v${ref.version}`;
}
