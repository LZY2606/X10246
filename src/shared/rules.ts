/**
 * 领域判断依据（机器可读事件 rationale_codes 使用）。
 * 这些常量同时出现在事件日志与 UI 中，保证"凭什么这样判"可复查。
 */
export const RULES = {
  INPUT_IMMUTABLE: "RULE:input_entities_immutable_after_commit",
  REVISION_AS_VERSION: "RULE:revision_is_new_version_with_parent",
  NO_GUESS_LOW_AMPLITUDE: "RULE:no_phase_guess_in_low_amplitude_regions",
  EXPLICIT_CUT_OFFSET: "RULE:integer_offsets_across_cuts_explicit",
  MULTIPLE_UNWRAP_TREES: "RULE:multiple_unwrap_trees_locally_consistent",
  KEEP_PATH_AND_CYCLE_RESIDUAL: "RULE:preserve_unwrap_path_and_cycle_residuals",
  KEEP_ALL_LEGAL_CANDIDATES: "RULE:keep_all_legal_candidates_when_nonunique",
  CYCLE_MUST_CLOSE: "RULE:cycle_must_close_within_tolerance",
  CUT_BETWEEN_OPPOSITE_RESIDUES: "RULE:cut_between_opposite_residue_charges",
  RESIDUE_TO_BORDER: "RULE:unpaired_residue_cut_to_border",
  WRAP_RANGE: "RULE:wrapped_phase_in_open_closed_minus_pi_pi",
  UNITS_PRESERVED_RAW: "RULE:domain_quantities_carry_units_raw_preserved",
  NORMALIZE_DERIVED_ONLY: "RULE:normalization_only_in_derived_layer",
  UNCONVERTIBLE_STAYS: "RULE:unconvertible_values_stay_in_place_with_diagnostic",
  WAVELENGTH_BINDING: "RULE:calibration_binds_wavelength_version",
  WAVELENGTH_CHANGE_INVALIDATES_HEIGHT: "RULE:wavelength_change_only_invalidates_dependent_chain",
  LOCAL_CHANGE_LOCAL_EXPIRY: "RULE:local_input_change_expires_only_dependents",
  EXPIRED_NOT_CURRENT: "RULE:expired_results_viewable_but_not_current",
  MISSING_REF_IS_CORRUPT: "RULE:missing_versioned_reference_is_corruption_no_latest_fallback",
  LOCK_NEEDS_CONSISTENT_CANDIDATE: "RULE:local_lock_requires_consistent_candidate",
  LOCK_CONFLICT_RECORDED: "RULE:conflicting_locks_recorded_not_silently_overwritten",
  UNDO_IS_EVENT: "RULE:undo_written_into_history",
  PIN_RESTORES_DEPENDENCY_VERSIONS: "RULE:pin_restores_exact_dependency_versions",
  COUNTEREXAMPLE_BASELINE_IMMUTABLE: "RULE:counterexample_baseline_never_overwritten",
  SINGLE_SOURCE_VARIATION: "RULE:counterexample_changes_one_direct_source",
  SHARED_FRAGMENT_SINGLE_COPY: "RULE:shared_raw_fragment_stored_once_immutable",
  INDEPENDENT_INTERPRETATIONS: "RULE:interpretations_diagnostics_decisions_independent",
} as const;

export type RuleCode = (typeof RULES)[keyof typeof RULES];

/** 反例情形 → 触发该情形时必须留痕的规则。 */
export const SCENARIO_RULES: Record<string, RuleCode[]> = {
  phase_wrap_boundary: [RULES.WRAP_RANGE, RULES.EXPLICIT_CUT_OFFSET],
  low_amplitude_hole: [RULES.NO_GUESS_LOW_AMPLITUDE, RULES.UNCONVERTIBLE_STAYS],
  multiply_connected: [RULES.MULTIPLE_UNWRAP_TREES, RULES.KEEP_ALL_LEGAL_CANDIDATES],
  cycle_nonclosure: [RULES.CYCLE_MUST_CLOSE, RULES.KEEP_PATH_AND_CYCLE_RESIDUAL],
  wavelength_version_change: [
    RULES.WAVELENGTH_BINDING,
    RULES.WAVELENGTH_CHANGE_INVALIDATES_HEIGHT,
    RULES.LOCAL_CHANGE_LOCAL_EXPIRY,
  ],
  integer_cycle_ambiguity: [RULES.EXPLICIT_CUT_OFFSET, RULES.KEEP_ALL_LEGAL_CANDIDATES],
  local_lock_conflict: [RULES.LOCK_CONFLICT_RECORDED, RULES.LOCK_NEEDS_CONSISTENT_CANDIDATE],
};
