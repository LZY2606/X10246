import type { DatabaseSync } from 'node:sqlite';
import { stableHash, stableId } from '../domain/identity.ts';
import { analyzeUnwrapping, parameterFingerprint, type LockConstraint } from '../domain/unwrap.ts';
import type {
  ArtifactRole,
  ArtifactVersion,
  InterferometryFrameInput,
  Quantity,
  UnwrapParameters,
  UnwrapRun,
  VersionRef
} from '../domain/types.ts';

export interface CasePack {
  schema: string;
  title: string;
  checksum: string;
  fragments: Array<{
    fragmentId: string;
    role: ArtifactRole;
    name: string;
    immutable: boolean;
    contentHash: string;
    content: unknown;
  }>;
  scenarios: Array<{
    code: string;
    title: string;
    minimalInput: { inputId: string; scenarioId: string; interpretationVersion: string; fragmentBindings: Record<ArtifactRole, string[]> };
    combinedInput: { inputId: string; scenarioId: string; interpretationVersion: string; fragmentBindings: Record<ArtifactRole, string[]> };
  }>;
  replay: unknown[];
}

interface ReviewEventRow {
  event_id: string;
  project_id: string;
  sequence_no: number;
  event_type: string;
  target_kind: string;
  target_id: string;
  run_id: string | null;
  candidate_id: string | null;
  payload_json: string;
  direct_sources_json: string;
  created_at: string;
}

const ROLES: ArtifactRole[] = [
  'wrapped_phase_pixels',
  'amplitude_map',
  'signal_quality_scores',
  'invalid_mask',
  'wavelength',
  'illumination_geometry',
  'calibration_surface',
  'cut_edit_history'
];

export class CorruptLedgerError extends Error {
  constructor(message: string) {
    super(`CORRUPT_REFERENCE:${message}`);
  }
}

export class Ledger {
  constructor(private readonly db: DatabaseSync) {}

  createProject(casePack: CasePack, nowIso: string, name = '光学实验室二维相位展开复核'): string {
    const projectId = stableId('project', [casePack.title, casePack.checksum]);
    const existing = this.db.prepare('select project_id from projects where project_id=?').get(projectId);
    if (existing) return projectId;

    const tx = this.db.prepare('insert into projects(project_id,name,case_pack_checksum,created_at) values(?,?,?,?)');
    tx.run(projectId, name, casePack.checksum, nowIso);
    this.db.prepare('insert into project_case_pack(project_id,case_pack_json,checksum) values(?,?,?)')
      .run(projectId, JSON.stringify(casePack), casePack.checksum);

    const fragmentStatement = this.db.prepare(`
      insert or ignore into case_pack_fragments(fragment_id,role,name,immutable,content_hash,content_json)
      values(?,?,?,?,?,?)
    `);
    for (const fragment of casePack.fragments) {
      fragmentStatement.run(fragment.fragmentId, fragment.role, fragment.name, fragment.immutable ? 1 : 0, fragment.contentHash, JSON.stringify(fragment.content));
    }

    for (const role of ROLES) {
      const fragments = casePack.fragments.filter((fragment) => fragment.role === role);
      fragments.sort((a, b) => a.name.localeCompare(b.name));
      for (const fragment of fragments) this.upsertArtifact(projectId, role, [fragment.fragmentId], fragment.content, `casepack:${fragment.name}`, nowIso);
    }

    this.appendEvent(projectId, 'BASELINE_IMPORTED', 'project', projectId, null, null, {
      immutableEntities: ROLES,
      scenarioCount: casePack.scenarios.length,
      casePackChecksum: casePack.checksum
    }, [], nowIso);
    return projectId;
  }

  private upsertArtifact(
    projectId: string,
    role: ArtifactRole,
    fragmentIds: string[],
    content: unknown,
    interpretationVersion: string,
    nowIso: string
  ): ArtifactVersion {
    const contentHash = stableHash(content);
    const artifactId = stableId('art', [projectId, role]);
    const contentId = stableId('artcontent', [projectId, role, contentHash]);
    const existing = this.db.prepare('select * from artifact_versions where content_id=?').get(contentId) as
      | { content_id: string }
      | undefined;
    if (existing) return this.getArtifactVersion(contentId);

    const previous = this.db.prepare('select content_id from artifact_versions where artifact_id=? order by version desc limit 1')
      .get(artifactId) as { content_id: string } | undefined;
    const row = this.db.prepare('select coalesce(max(version),0)+1 as next from artifact_versions where artifact_id=?').get(artifactId) as { next: number };
    const quantity = toQuantity(role, content);
    this.db.prepare(`
      insert into artifact_versions(artifact_id,version,content_id,parent_content_id,role,source_fragment_ids_json,
        interpretation_version,quantity_json,content_hash,created_at)
      values(?,?,?,?,?,?,?,?,?,?)
    `).run(artifactId, row.next, contentId, previous?.content_id ?? null, role, JSON.stringify(fragmentIds),
      interpretationVersion, JSON.stringify(quantity), contentHash, nowIso);
    return this.getArtifactVersion(contentId);
  }

  getArtifactVersion(contentId: string): ArtifactVersion {
    const row = this.db.prepare('select * from artifact_versions where content_id=?').get(contentId) as
      | Record<string, string | number | null>
      | undefined;
    if (!row) throw new CorruptLedgerError(`missing artifact ${contentId}`);
    return {
      artifactId: String(row.artifact_id),
      version: Number(row.version),
      contentId: String(row.content_id),
      parentContentId: row.parent_content_id ? String(row.parent_content_id) : null,
      role: row.role as ArtifactRole,
      quantity: JSON.parse(String(row.quantity_json)) as Quantity,
      contentHash: String(row.content_hash),
      sourceFragmentIds: JSON.parse(String(row.source_fragment_ids_json)) as string[],
      interpretationVersion: String(row.interpretation_version),
      createdAt: String(row.created_at)
    };
  }

  private fragmentContent(projectId: string, fragmentId: string): unknown {
    const row = this.db.prepare('select content_json from case_pack_fragments where fragment_id=?').get(fragmentId) as
      | { content_json: string }
      | undefined;
    if (!row) throw new CorruptLedgerError(`missing shared fragment ${fragmentId} in project ${projectId}`);
    return JSON.parse(row.content_json) as unknown;
  }

  private selectedInput(projectId: string, scenarioId: string, kind: 'minimalInput' | 'combinedInput') {
    const row = this.db.prepare('select case_pack_json from project_case_pack where project_id=?').get(projectId) as
      | { case_pack_json: string }
      | undefined;
    if (!row) throw new CorruptLedgerError(`missing case pack for project ${projectId}`);
    const pack = JSON.parse(row.case_pack_json) as CasePack;
    const scenario = pack.scenarios.find((item) => item.code === scenarioId);
    if (!scenario) throw new Error(`UNKNOWN_SCENARIO:${scenarioId}`);
    return scenario[kind];
  }

  private artifactForFragment(projectId: string, role: ArtifactRole, fragmentId: string): ArtifactVersion {
    const hash = this.db.prepare('select content_hash from case_pack_fragments where fragment_id=?').get(fragmentId) as
      | { content_hash: string }
      | undefined;
    if (!hash) throw new CorruptLedgerError(`missing fragment ${fragmentId}`);
    const contentId = stableId('artcontent', [projectId, role, hash.content_hash]);
    return this.getArtifactVersion(contentId);
  }

  private buildFrame(projectId: string, scenarioId: string, kind: 'minimalInput' | 'combinedInput'): InterferometryFrameInput {
    const input = this.selectedInput(projectId, scenarioId, kind);
    const get = (role: ArtifactRole) => {
      const fragmentId = input.fragmentBindings[role][0];
      if (!fragmentId) throw new CorruptLedgerError(`${scenarioId}.${role} has no source fragment reference`);
      return fragmentId;
    };
    return {
      scenarioId,
      interpretationVersion: input.interpretationVersion,
      wrappedPhase: this.fragmentContent(projectId, get('wrapped_phase_pixels')) as InterferometryFrameInput['wrappedPhase'],
      amplitude: this.fragmentContent(projectId, get('amplitude_map')) as InterferometryFrameInput['amplitude'],
      signalQuality: this.fragmentContent(projectId, get('signal_quality_scores')) as InterferometryFrameInput['signalQuality'],
      invalidMask: this.fragmentContent(projectId, get('invalid_mask')) as InterferometryFrameInput['invalidMask'],
      wavelength: this.fragmentContent(projectId, get('wavelength')) as InterferometryFrameInput['wavelength'],
      illuminationGeometry: this.fragmentContent(projectId, get('illumination_geometry')) as InterferometryFrameInput['illuminationGeometry'],
      calibrationSurface: this.fragmentContent(projectId, get('calibration_surface')) as InterferometryFrameInput['calibrationSurface'],
      cutEditHistory: this.fragmentContent(projectId, get('cut_edit_history')) as InterferometryFrameInput['cutEditHistory'],
      fragmentBindings: input.fragmentBindings
    };
  }

  private paramsFor(projectId: string, scenarioId: string, kind: 'minimalInput' | 'combinedInput', overrides: Partial<UnwrapParameters> = {}): UnwrapParameters {
    const input = this.selectedInput(projectId, scenarioId, kind);
    const content = (role: ArtifactRole) => this.artifactForFragment(projectId, role, input.fragmentBindings[role][0]!).contentId;
    const params: UnwrapParameters = {
      algorithmVersion: 'fringe-ledger/tree-cycle-v1',
      amplitudeThreshold: kind === 'combinedInput' ? 100 : 50,
      qualityThreshold: kind === 'combinedInput' ? 0.25 : 0.15,
      ambiguityWindowTurns: 1,
      heightTransferFunction: 'four_step_reflection_normal_incidence',
      wavelengthContentId: content('wavelength'),
      geometryContentId: content('illumination_geometry'),
      calibrationContentId: content('calibration_surface'),
      phaseContentId: content('wrapped_phase_pixels'),
      maskContentId: content('invalid_mask'),
      amplitudeContentId: content('amplitude_map'),
      qualityContentId: content('signal_quality_scores'),
      cutHistoryContentId: content('cut_edit_history')
    };
    return { ...params, ...overrides };
  }

  createRun(
    projectId: string,
    scenarioId: string,
    kind: 'minimalInput' | 'combinedInput',
    nowIso: string,
    parameterOverrides: Partial<UnwrapParameters> = {},
    parentRunId: string | null = null
  ): UnwrapRun {
    const frame = this.buildFrame(projectId, scenarioId, kind);
    const parameters = { ...this.paramsFor(projectId, scenarioId, kind), ...parameterOverrides };
    const fullParameters = { ...parameters, parameterFingerprint: parameterFingerprint(parameters) };
    const locks = this.activeLocks(projectId);
    const run = analyzeUnwrapping(frame, { ...parameters, parameterFingerprint: fullParameters.parameterFingerprint }, locks, nowIso, parentRunId);
    this.persistRun(projectId, run, kind === 'minimalInput' ? this.selectedInput(projectId, scenarioId, 'minimalInput').inputId : this.selectedInput(projectId, scenarioId, 'combinedInput').inputId);
    this.appendEvent(projectId, 'RUN_COMPUTED', 'run', run.runId, run.runId, null, {
      scenarioId,
      inputKind: kind,
      parameterFingerprint: run.parameterFingerprint,
      candidateCount: run.candidates.length,
      diagnostics: run.diagnostics
    }, run.directSources, nowIso);
    return run;
  }

  private persistRun(projectId: string, run: UnwrapRun, inputId: string): void {
    this.db.prepare(`
      insert into runs(run_id,project_id,parent_run_id,scenario_id,input_id,parameters_json,parameter_fingerprint,
        status,diagnostics_json,direct_sources_json,created_at)
      values(?,?,?,?,?,?,?,?,?,?,?)
    `).run(run.runId, projectId, run.parentRunId, run.scenarioId, inputId, JSON.stringify(run.parameters),
      run.parameterFingerprint, run.status, JSON.stringify(run.diagnostics), JSON.stringify(run.directSources), run.createdAt);

    const pixel = this.db.prepare(`
      insert into run_pixels(project_id,run_id,pixel_id,row_no,col_no,wrapped_phase_rad,amplitude,quality_score,valid,component_id,refs_json)
      values(?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const item of run.pixels) {
      pixel.run(projectId, run.runId, item.pixelId, item.row, item.col, nullableNumber(item.wrappedPhaseRad),
        nullableNumber(item.amplitude), nullableNumber(item.qualityScore), item.valid ? 1 : 0, item.componentId, JSON.stringify(item.refs));
    }

    const edge = this.db.prepare(`
      insert into run_edges(project_id,run_id,edge_id,from_pixel_id,to_pixel_id,row_a,col_a,row_b,col_b,
        wrapped_delta_rad,nearest_offset_turns,explicit_offset_turns,selected_offset_turns,edge_kind,quality_score,
        component_id,diagnostic,refs_json)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const item of run.edges) {
      edge.run(projectId, run.runId, item.edgeId, item.fromPixelId, item.toPixelId, item.rowA, item.colA, item.rowB, item.colB,
        item.wrappedDeltaRad, item.nearestOffsetTurns, item.explicitOffsetTurns, item.selectedOffsetTurns,
        item.edgeKind, item.qualityScore, item.componentId, item.diagnostic, JSON.stringify(item.refs));
    }

    const candidate = this.db.prepare(`
      insert into run_candidates(project_id,run_id,candidate_id,candidate_number,root_pixel_id,tree_edge_ids_json,
        status,status_reason,legal_integer_offsets_json,rejected_edge_ids_json,refs_json)
      values(?,?,?,?,?,?,?,?,?,?,?)
    `);
    const cycle = this.db.prepare(`
      insert into run_cycles(project_id,run_id,candidate_id,cycle_id,anchor_pixel_id,edge_ids_json,residual_turns,
        status,diagnostic,refs_json) values(?,?,?,?,?,?,?,?,?,?)
    `);
    const phaseValue = this.db.prepare(`
      insert into run_candidate_pixels(project_id,run_id,candidate_id,value_id,pixel_id,row_no,col_no,
        unwrapped_phase_rad,relative_calibration_phase_rad,status,refs_json)
      values(?,?,?,?,?,?,?,?,?,?,?)
    `);
    const height = this.db.prepare(`
      insert into run_heights(project_id,run_id,candidate_id,height_id,pixel_id,row_no,col_no,height_nanometers,
        transfer_chain_json,status,diagnostic,refs_json) values(?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    for (const item of run.candidates) {
      candidate.run(projectId, run.runId, item.candidateId, item.candidateNumber, item.rootPixelId,
        JSON.stringify(item.treeEdgeIds), item.status, item.statusReason, JSON.stringify(item.legalIntegerOffsets),
        JSON.stringify(item.rejectedEdgeIds), JSON.stringify(item.refs));
      for (const residual of item.cycleResiduals) {
        cycle.run(projectId, run.runId, item.candidateId, residual.cycleId, residual.anchorPixelId,
          JSON.stringify(residual.edgeIds), residual.residualTurns, residual.status, residual.diagnostic, JSON.stringify(residual.refs));
      }
      for (const value of item.pixels) {
        phaseValue.run(projectId, run.runId, item.candidateId, value.valueId, value.pixelId, value.row, value.col,
          value.unwrappedPhaseRad, value.relativeCalibrationPhaseRad, value.status, JSON.stringify(value.refs));
      }
      for (const value of item.heights) {
        height.run(projectId, run.runId, item.candidateId, value.heightId, value.pixelId, value.row, value.col,
          value.heightNanometers, JSON.stringify(value.transferChain), value.status, value.diagnostic, JSON.stringify(value.refs));
      }
    }
  }

  appendEvent(
    projectId: string,
    eventType: string,
    targetKind: string,
    targetId: string,
    runId: string | null,
    candidateId: string | null,
    payload: unknown,
    directSources: VersionRef[],
    nowIso: string
  ): string {
    const sequenceRow = this.db.prepare('select coalesce(max(sequence_no),0)+1 as next from review_events where project_id=?')
      .get(projectId) as { next: number };
    const eventId = stableId('event', [projectId, sequenceRow.next, eventType, targetId, payload]);
    this.db.prepare(`
      insert into review_events(event_id,project_id,sequence_no,event_type,target_kind,target_id,run_id,candidate_id,
        payload_json,direct_sources_json,created_at)
      values(?,?,?,?,?,?,?,?,?,?,?)
    `).run(eventId, projectId, sequenceRow.next, eventType, targetKind, targetId, runId, candidateId,
      JSON.stringify(payload), JSON.stringify(directSources), nowIso);
    return eventId;
  }

  decideCandidate(
    projectId: string,
    runId: string,
    candidateId: string,
    decision: 'accepted' | 'rejected' | 'parameter_adjustment_requested',
    note: string,
    nowIso: string
  ): string {
    const run = this.getRun(runId);
    const candidate = run.candidates.find((item) => item.candidateId === candidateId);
    if (!candidate) throw new Error(`UNKNOWN_CANDIDATE:${candidateId}`);
    const eventType = decision === 'accepted' ? 'CANDIDATE_ACCEPTED' : decision === 'rejected' ? 'CANDIDATE_REJECTED' : 'PARAMETER_ADJUSTMENT_REQUESTED';
    return this.appendEvent(projectId, eventType, 'candidate', candidateId, runId, candidateId, {
      decision,
      note,
      candidateNumber: candidate.candidateNumber,
      treeEdgeIds: candidate.treeEdgeIds,
      cycleResiduals: candidate.cycleResiduals.map((item) => ({ cycleId: item.cycleId, residualTurns: item.residualTurns, status: item.status })),
      parameterFingerprint: run.parameterFingerprint
    }, candidate.refs.concat(run.directSources), nowIso);
  }

  addLock(
    projectId: string,
    runId: string,
    edge: { rowA: number; colA: number; rowB: number; colB: number },
    requiredOffsetTurns: number,
    nowIso: string
  ): string {
    const run = this.getRun(runId);
    const edgeRecord = run.edges.find((item) =>
      item.rowA === edge.rowA && item.colA === edge.colA && item.rowB === edge.rowB && item.colB === edge.colB
    );
    if (!edgeRecord) throw new Error('LOCK_REFERENCES_MISSING_EDGE');
    const eventId = this.appendEvent(projectId, 'LOCAL_INTERPRETATION_LOCKED', 'edge', edgeRecord.edgeId, runId, null, {
      ...edge,
      edgeId: edgeRecord.edgeId,
      requiredOffsetTurns,
      selectedAt: nowIso
    }, edgeRecord.refs.concat(run.directSources), nowIso);
    const lockId = stableId('lock', [projectId, runId, edgeRecord.edgeId, requiredOffsetTurns, eventId]);
    this.db.prepare(`
      insert into local_locks(lock_id,project_id,run_id,candidate_id,row_a,col_a,row_b,col_b,
        required_offset_turns,created_event_id,revoked_event_id,active,created_at)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(lockId, projectId, runId, null, edge.rowA, edge.colA, edge.rowB, edge.colB,
      requiredOffsetTurns, eventId, null, 1, nowIso);
    return lockId;
  }

  undoLock(projectId: string, lockId: string, note: string, nowIso: string): void {
    const lock = this.db.prepare('select * from local_locks where lock_id=? and project_id=?').get(lockId, projectId) as
      | Record<string, string | number | null>
      | undefined;
    if (!lock) throw new Error(`UNKNOWN_LOCK:${lockId}`);
    const eventId = this.appendEvent(projectId, 'LOCAL_LOCK_REVOKED', 'lock', lockId, String(lock.run_id ?? ''), null, {
      note,
      previousRequiredOffsetTurns: Number(lock.required_offset_turns)
    }, [], nowIso);
    this.db.prepare('update local_locks set active=0, revoked_event_id=? where lock_id=?').run(eventId, lockId);
  }

  private activeLocks(projectId: string): LockConstraint[] {
    const rows = this.db.prepare('select * from local_locks where project_id=? and active=1').all(projectId) as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      lockId: String(row.lock_id),
      rowA: Number(row.row_a),
      colA: Number(row.col_a),
      rowB: Number(row.row_b),
      colB: Number(row.col_b),
      requiredOffsetTurns: Number(row.required_offset_turns),
      candidateId: row.candidate_id ? String(row.candidate_id) : null
    }));
  }

  events(projectId: string): Array<Record<string, unknown>> {
    return (this.db.prepare('select * from review_events where project_id=? order by sequence_no asc').all(projectId) as ReviewEventRow[])
      .map((row) => ({
        eventId: row.event_id,
        sequence: row.sequence_no,
        type: row.event_type,
        targetKind: row.target_kind,
        targetId: row.target_id,
        runId: row.run_id,
        candidateId: row.candidate_id,
        createdAt: row.created_at,
        payload: JSON.parse(row.payload_json),
        directSources: JSON.parse(row.direct_sources_json) as VersionRef[]
      }));
  }

  listRuns(projectId: string): Array<{ runId: string; scenarioId: string; status: string; createdAt: string }> {
    return (this.db.prepare('select run_id,scenario_id,status,created_at from runs where project_id=? order by created_at').all(projectId) as
      Array<{ run_id: string; scenario_id: string; status: string; created_at: string }>)
      .map((row) => ({ runId: row.run_id, scenarioId: row.scenario_id, status: row.status, createdAt: row.created_at }));
  }

  getRun(runId: string): UnwrapRun {
    const runRow = this.db.prepare('select * from runs where run_id=?').get(runId) as
      | Record<string, string | null>
      | undefined;
    if (!runRow) throw new Error(`UNKNOWN_RUN:${runId}`);
    const pixels = (this.db.prepare('select * from run_pixels where run_id=?').all(runId) as Array<Record<string, string | number | null>>)
      .map((row) => ({
        pixelId: String(row.pixel_id),
        row: Number(row.row_no),
        col: Number(row.col_no),
        wrappedPhaseRad: numberOrNull(row.wrapped_phase_rad),
        amplitude: numberOrNull(row.amplitude),
        qualityScore: numberOrNull(row.quality_score),
        valid: Number(row.valid) === 1,
        componentId: row.component_id ? String(row.component_id) : null,
        refs: JSON.parse(String(row.refs_json)) as VersionRef[]
      }));
    const edges = (this.db.prepare('select * from run_edges where run_id=?').all(runId) as Array<Record<string, string | number | null>>)
      .map((row) => ({
        edgeId: String(row.edge_id),
        fromPixelId: String(row.from_pixel_id),
        toPixelId: String(row.to_pixel_id),
        rowA: Number(row.row_a),
        colA: Number(row.col_a),
        rowB: Number(row.row_b),
        colB: Number(row.col_b),
        wrappedDeltaRad: Number(row.wrapped_delta_rad),
        nearestOffsetTurns: Number(row.nearest_offset_turns),
        explicitOffsetTurns: numberOrNull(row.explicit_offset_turns),
        selectedOffsetTurns: numberOrNull(row.selected_offset_turns),
        edgeKind: String(row.edge_kind) as 'trusted' | 'low_amplitude' | 'cut' | 'mask_boundary',
        qualityScore: Number(row.quality_score),
        componentId: row.component_id ? String(row.component_id) : null,
        diagnostic: row.diagnostic ? String(row.diagnostic) : null,
        refs: JSON.parse(String(row.refs_json)) as VersionRef[]
      }));
    const candidateRows = this.db.prepare('select * from run_candidates where run_id=? order by candidate_number').all(runId) as
      Array<Record<string, string | number | null>>;
    const candidates = candidateRows.map((candidateRow) => {
      const candidateId = String(candidateRow.candidate_id);
      const cycleResiduals = (this.db.prepare('select * from run_cycles where run_id=? and candidate_id=?').all(runId, candidateId) as
        Array<Record<string, string | number | null>>).map((row) => ({
        cycleId: String(row.cycle_id),
        candidateId,
        anchorPixelId: String(row.anchor_pixel_id),
        edgeIds: JSON.parse(String(row.edge_ids_json)) as string[],
        residualTurns: numberOrNull(row.residual_turns),
        status: String(row.status) as 'valid' | 'invalid' | 'unknown' | 'stale' | 'conflicted',
        diagnostic: String(row.diagnostic),
        refs: JSON.parse(String(row.refs_json)) as VersionRef[]
      }));
      const pixelsValues = (this.db.prepare('select * from run_candidate_pixels where run_id=? and candidate_id=?').all(runId, candidateId) as
        Array<Record<string, string | number | null>>).map((row) => ({
        valueId: String(row.value_id),
        candidateId,
        pixelId: String(row.pixel_id),
        row: Number(row.row_no),
        col: Number(row.col_no),
        unwrappedPhaseRad: numberOrNull(row.unwrapped_phase_rad),
        relativeCalibrationPhaseRad: numberOrNull(row.relative_calibration_phase_rad),
        status: String(row.status) as 'valid' | 'invalid' | 'unknown' | 'stale' | 'conflicted',
        refs: JSON.parse(String(row.refs_json)) as VersionRef[]
      }));
      const heights = (this.db.prepare('select * from run_heights where run_id=? and candidate_id=?').all(runId, candidateId) as
        Array<Record<string, string | number | null>>).map((row) => ({
        heightId: String(row.height_id),
        candidateId,
        pixelId: String(row.pixel_id),
        row: Number(row.row_no),
        col: Number(row.col_no),
        heightNanometers: numberOrNull(row.height_nanometers),
        transferChain: JSON.parse(String(row.transfer_chain_json)) as UnwrapRun['candidates'][number]['heights'][number]['transferChain'],
        status: String(row.status) as 'valid' | 'invalid' | 'unknown' | 'stale' | 'conflicted',
        diagnostic: row.diagnostic ? String(row.diagnostic) : null,
        refs: JSON.parse(String(row.refs_json)) as VersionRef[]
      }));
      return {
        candidateId,
        candidateNumber: Number(candidateRow.candidate_number),
        treeEdgeIds: JSON.parse(String(candidateRow.tree_edge_ids_json)) as string[],
        rootPixelId: String(candidateRow.root_pixel_id),
        status: String(candidateRow.status) as UnwrapRun['candidates'][number]['status'],
        statusReason: String(candidateRow.status_reason),
        legalIntegerOffsets: JSON.parse(String(candidateRow.legal_integer_offsets_json)) as Record<string, number[]>,
        rejectedEdgeIds: JSON.parse(String(candidateRow.rejected_edge_ids_json)) as string[],
        cycleResiduals,
        pixels: pixelsValues,
        heights,
        refs: JSON.parse(String(candidateRow.refs_json)) as VersionRef[]
      };
    });
    return {
      runId,
      parentRunId: runRow.parent_run_id ? String(runRow.parent_run_id) : null,
      scenarioId: String(runRow.scenario_id),
      parameters: JSON.parse(String(runRow.parameters_json)) as UnwrapParameters,
      parameterFingerprint: String(runRow.parameter_fingerprint),
      status: String(runRow.status) as UnwrapRun['status'],
      pixels,
      edges,
      candidates,
      diagnostics: JSON.parse(String(runRow.diagnostics_json)) as string[],
      directSources: JSON.parse(String(runRow.direct_sources_json)) as VersionRef[],
      createdAt: String(runRow.created_at)
    };
  }

  reviewModel(projectId: string, runId: string, atEventId?: string) {
    const run = this.getRun(runId);
    const sequence = atEventId
      ? (this.db.prepare('select sequence_no from review_events where event_id=? and project_id=?').get(atEventId, projectId) as { sequence_no: number } | undefined)?.sequence_no
      : undefined;
    if (atEventId && sequence === undefined) throw new Error(`UNKNOWN_EVENT:${atEventId}`);
    const eventRows = this.db.prepare('select * from review_events where project_id=? and (? is null or sequence_no <= ?) order by sequence_no')
      .all(projectId, sequence ?? null, sequence ?? null) as ReviewEventRow[];
    const decisions = new Map<string, { eventId: string; decision: string; note: string; createdAt: string }>();
    for (const row of eventRows) {
      if (row.run_id !== runId) continue;
      if (row.event_type === 'CANDIDATE_ACCEPTED') decisions.set(row.candidate_id!, { eventId: row.event_id, decision: 'accepted', note: JSON.parse(row.payload_json).note, createdAt: row.created_at });
      if (row.event_type === 'CANDIDATE_REJECTED') decisions.set(row.candidate_id!, { eventId: row.event_id, decision: 'rejected', note: JSON.parse(row.payload_json).note, createdAt: row.created_at });
    }
    const candidates = run.candidates.map((candidate) => {
      const decision = decisions.get(candidate.candidateId);
      return { ...candidate, humanDecision: decision ?? null, effectiveStatus: decision?.decision ?? candidate.status };
    });
    return { ...run, candidates, events: eventRows.map((row) => ({ eventId: row.event_id, sequence: row.sequence_no, type: row.event_type, payload: JSON.parse(row.payload_json), directSources: JSON.parse(row.direct_sources_json) })) };
  }
