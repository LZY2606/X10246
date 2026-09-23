import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';
import { contentRef, shortDigest, digestOfString } from '../core/identity.js';
import { VirtualClock } from '../core/clock.js';
import {
  DEFAULT_PARAMS,
  rawSource,
  runPipeline,
  type PipelineParams,
  type RawSnapshot
} from '../core/pipeline.js';
import type {
  ConflictRecord,
  DerivedArtifact,
  HistoryEvent,
  IntegerCandidate,
  LockDecision,
  RawKind,
  RawPayload,
  RawVersion,
  SourceRef
} from '../core/types.js';
import { summaryOf } from '../core/pipeline.js';

export class CorruptReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptReferenceError';
  }
}

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: number;
  clockNow: number;
  eventSeq: number;
  seed: number;
}

let openCount = 0;

export class ProjectStore {
  readonly db: DatabaseSync;
  readonly clock: VirtualClock;
  readonly projectId: string;

  private constructor(db: DatabaseSync, clock: VirtualClock, projectId: string) {
    this.db = db;
    this.clock = clock;
    this.projectId = projectId;
  }

  static open(path: string): ProjectStore {
    const db = new DatabaseSync(path);
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)').run(
      'schema_version',
      String(SCHEMA_VERSION)
    );
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('active_project') as
      | { value: string }
      | undefined;
    let projectId: string;
    let clockStart = 0;
    if (!row) {
      projectId = `proj_${shortDigest({ created: 0, n: openCount })}`;
      openCount += 1;
      db.prepare('INSERT INTO projects(id,name,created_at,clock_now,event_seq,seed) VALUES (?,?,?,?,?,?)').run(
        projectId,
        'Fringe Ledger review',
        0,
        0,
        0,
        DEFAULT_PARAMS.seed
      );
      db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('active_project', projectId);
    } else {
      projectId = row.value;
      const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as {
        clock_now: number;
      };
      clockStart = project.clock_now;
    }
    const clock = new VirtualClock(clockStart);
    return new ProjectStore(db, clock, projectId);
  }

  project(): ProjectRecord {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(this.projectId) as {
      id: string;
      name: string;
      created_at: number;
      clock_now: number;
      event_seq: number;
      seed: number;
    };
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      clockNow: row.clock_now,
      eventSeq: row.event_seq,
      seed: row.seed
    };
  }

  // -------------------------------------------------------------------------
  // Raw inputs: immutable submit, new versions with parent relationships
  // -------------------------------------------------------------------------

  submitRaw(input: {
    kind: RawKind;
    payload: RawPayload;
    submittedBy?: string;
    note?: string;
  }): RawVersion {
    const { kind, payload } = input;
    if (payload.kind !== kind) {
      throw new Error(`payload kind ${payload.kind} does not match submitted lineage ${kind}`);
    }
    const ref = contentRef(payload);
    // Same content in a lineage already exists: return it, never overwrite.
    const duplicate = this.db
      .prepare('SELECT version FROM raw_versions WHERE project_id=? AND lineage=? AND sha256=?')
      .get(this.projectId, kind, ref.sha256) as { version: number } | undefined;
    if (duplicate) {
      return this.getRawVersion(kind, duplicate.version)!;
    }
    const latest = this.latestRawVersionNumber(kind);
    const version = latest + 1;
    const at = this.clock.tick(1);
    this.db
      .prepare(
        `INSERT INTO raw_versions
          (project_id,lineage,version,parent_version,sha256,bytes,payload,recorded_at,submitted_by,note)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        this.projectId,
        kind,
        version,
        latest === 0 ? null : latest,
        ref.sha256,
        ref.bytes,
        JSON.stringify(payload),
        at,
        input.submittedBy ?? 'lab-operator',
        input.note ?? ''
      );
    this.recordEvent('RAW_INPUT_SUBMITTED', input.submittedBy ?? 'lab-operator', {
      lineage: kind,
      version,
      parentVersion: latest === 0 ? null : latest,
      note: input.note ?? ''
    }, [
      {
        kind: 'raw_version',
        id: `${kind}@v${version}`,
        version,
        sha256: ref.sha256,
        summary: summaryOf(payload)
      }
    ]);
    this.markStaleFor(kind);
    return this.getRawVersion(kind, version)!;
  }

  private latestRawVersionNumber(kind: RawKind): number {
    const row = this.db
      .prepare('SELECT MAX(version) AS v FROM raw_versions WHERE project_id=? AND lineage=?')
      .get(this.projectId, kind) as { v: number | null };
    return row.v ?? 0;
  }

  listRawVersions(kind: RawKind): RawVersion[] {
    const rows = this.db
      .prepare('SELECT * FROM raw_versions WHERE project_id=? AND lineage=? ORDER BY version')
      .all(this.projectId, kind) as Array<Record<string, unknown>>;
    return rows.map((row) => this.hydrateRaw(row));
  }

  getRawVersion(kind: RawKind, version: number): RawVersion | null {
    const row = this.db
      .prepare('SELECT * FROM raw_versions WHERE project_id=? AND lineage=? AND version=?')
      .get(this.projectId, kind, version) as Record<string, unknown> | undefined;
    return row ? this.hydrateRaw(row) : null;
  }

  private hydrateRaw(row: Record<string, unknown>): RawVersion {
    return {
      version: row['version'] as number,
      parentVersion: (row['parent_version'] as number | null) ?? null,
      lineage: row['lineage'] as RawKind,
      ref: { sha256: row['sha256'] as string, bytes: row['bytes'] as number },
      recordedAt: row['recorded_at'] as number,
      submittedBy: row['submitted_by'] as string,
      note: row['note'] as string,
      payload: JSON.parse(row['payload'] as string) as RawPayload
    };
  }

  /** Snapshot at EXPLICIT versions. Never silently substitutes latest. */
  snapshotAt(versions: Partial<Record<RawKind, number>>): RawSnapshot {
    const snapshot: RawSnapshot = {};
    for (const key of Object.keys(versions) as RawKind[]) {
      const number = versions[key]!;
      const raw = this.getRawVersion(key, number);
      if (!raw) {
        throw new CorruptReferenceError(
          `missing referenced raw version ${key}@v${number} — reference is corrupt, no latest fallback`
        );
      }
      snapshot[key] = raw;
    }
    return snapshot;
  }

  latestSnapshot(): RawSnapshot {
    const kinds: RawKind[] = [
      'wrapped_phase',
      'amplitude',
      'snr_score',
      'validity_mask',
      'wavelength',
      'incidence_geometry',
      'calibration_surface',
      'cut_edit_history'
    ];
    const snapshot: RawSnapshot = {};
    for (const kind of kinds) {
      const number = this.latestRawVersionNumber(kind);
      if (number > 0) snapshot[kind] = this.getRawVersion(kind, number)!;
    }
    return snapshot;
  }
}

  // -------------------------------------------------------------------------
  // Event log
  // -------------------------------------------------------------------------

  recordEvent(
    type: HistoryEvent['type'],
    actor: string,
    payload: Record<string, unknown>,
    references: SourceRef[] = [],
    parentEventId: string | null = null
  ): HistoryEvent {
    const seq = this.nextEventSeq();
    const at = this.clock.tick(1);
    const id = `evt_${seq}_${digestOfString(`${type}|${seq}|${at}|${JSON.stringify(payload)}`).slice(0, 10)}`;
    this.db
      .prepare(
        `INSERT INTO events(project_id,event_id,seq,type,at,actor,payload,parent_event_id,seq_order)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(this.projectId, id, seq, type, at, actor, JSON.stringify(payload), parentEventId, seq);
    references.forEach((ref, order) => {
      this.db
        .prepare(
          `INSERT INTO event_references(project_id,event_id,ref_order,kind,ref_id,version,sha256,summary)
           VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(this.projectId, id, order, ref.kind, ref.id, ref.version ?? null, ref.sha256, ref.summary);
    });
    return { id, seq, type, at, actor, payload, references, parentEventId };
  }

  private nextEventSeq(): number {
    this.db.prepare('UPDATE projects SET event_seq = event_seq + 1 WHERE id=?').run(this.projectId);
    const row = this.db.prepare('SELECT event_seq AS s FROM projects WHERE id=?').get(this.projectId) as {
      s: number;
    };
    return row.s;
  }

  listEvents(): HistoryEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE project_id=? ORDER BY seq_order')
      .all(this.projectId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.hydrateEvent(row));
  }

  getEvent(eventId: string): HistoryEvent | null {
    const row = this.db
      .prepare('SELECT * FROM events WHERE project_id=? AND event_id=?')
      .get(this.projectId, eventId) as Record<string, unknown> | undefined;
    return row ? this.hydrateEvent(row) : null;
  }

  private hydrateEvent(row: Record<string, unknown>): HistoryEvent {
    const refs = this.db
      .prepare('SELECT * FROM event_references WHERE project_id=? AND event_id=? ORDER BY ref_order')
      .all(this.projectId, row['event_id']) as Array<Record<string, unknown>>;
    return {
      id: row['event_id'] as string,
      seq: row['seq'] as number,
      type: row['type'] as HistoryEvent['type'],
      at: row['at'] as number,
      actor: row['actor'] as string,
      payload: JSON.parse(row['payload'] as string) as Record<string, unknown>,
      references: refs.map((ref) => ({
        kind: ref['kind'] as SourceRef['kind'],
        id: ref['ref_id'] as string,
        version: (ref['version'] as number | null) ?? undefined,
        sha256: ref['sha256'] as string,
        summary: ref['summary'] as string
      })),
      parentEventId: (row['parent_event_id'] as string | null) ?? null
    };
  }

  // -------------------------------------------------------------------------
  // Derivations: explicit sources, fingerprints, stale on local source change
  // -------------------------------------------------------------------------

  private markStaleFor(kind: RawKind): void {
    const rows = this.db
      .prepare('SELECT artifact_id FROM artifact_sources WHERE project_id=? AND ref_id LIKE ?')
      .all(this.projectId, `${kind}@v%`) as Array<{ artifact_id: string }>;
    const marked = new Set<string>();
    for (const { artifact_id: artifactId } of rows) {
      if (marked.has(artifactId)) continue;
      this.db
        .prepare('UPDATE artifacts SET stale=1, status=? WHERE project_id=? AND artifact_id=? AND stale=0')
        .run('stale', this.projectId, artifactId);
      this.recordEvent('ARTIFACT_STALE', 'system', { artifactId, changedLineage: kind }, [
        { kind: 'artifact', id: artifactId, sha256: '', summary: `stale due to ${kind}` }
      ]);
      marked.add(artifactId);
    }
  }

  derive(
    params: PipelineParams = DEFAULT_PARAMS,
    versions?: Partial<Record<RawKind, number>>,
    chosenOffsets: Map<number, number> = new Map(),
    actor = 'lab-operator'
  ): DerivedArtifact[] {
    const snapshot = versions ? this.snapshotAt(versions) : this.latestSnapshot();
    const present = Object.keys(snapshot) as RawKind[];
    const needed: RawKind[] = [
      'wrapped_phase',
      'amplitude',
      'snr_score',
      'validity_mask',
      'wavelength',
      'incidence_geometry',
      'calibration_surface',
      'cut_edit_history'
    ];
    const missing = needed.filter((kind) => !present.includes(kind));
    if (missing.length) {
      throw new Error(`cannot derive, missing raw lineages: ${missing.join(', ')}`);
    }
    const run = runPipeline(snapshot, params, chosenOffsets);
    const seq = this.project().eventSeq;
    const stored: DerivedArtifact[] = [];
    run.artifacts.forEach((stage, order) => {
      const a = stage.artifact;
      const payloadText = JSON.stringify(a.payload);
      const id = `art_${a.kind}_${a.ref.sha256.slice(0, 12)}`;
      const exists = this.db
        .prepare('SELECT 1 FROM artifacts WHERE project_id=? AND artifact_id=?')
        .get(this.projectId, id);
      if (!exists) {
        this.db
          .prepare(
            `INSERT INTO artifacts(project_id,artifact_id,kind,status,stale,superseded_by,
               algorithm,algorithm_version,parameters,fingerprint,sha256,bytes,payload,diagnostic,created_at,created_seq)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          )
          .run(
            this.projectId,
            id,
            a.kind,
            'current',
            0,
            null,
            a.algorithm.algorithm,
            a.algorithm.algorithmVersion,
            JSON.stringify(a.algorithm.parameters),
            a.algorithm.fingerprint,
            a.ref.sha256,
            a.ref.bytes,
            payloadText,
            a.diagnostic ? JSON.stringify(a.diagnostic) : null,
            this.clock.tick(1),
            seq + order
          );
        a.sources.forEach((source, sourceOrder) => {
          this.db
            .prepare(
              `INSERT INTO artifact_sources(project_id,artifact_id,ref_order,kind,ref_id,version,sha256,summary)
               VALUES (?,?,?,?,?,?,?,?)`
            )
            .run(
              this.projectId,
              id,
              sourceOrder,
              source.kind,
              source.id,
              source.version ?? null,
              source.sha256,
              source.summary
            );
        });
        this.recordEvent(
          'DERIVATION_RECORDED',
          actor,
          { artifactId: id, kind: a.kind, fingerprint: a.algorithm.fingerprint },
          a.sources
        );
      }
      stored.push(this.getArtifact(id)!);
    });

    this.generateCandidates(run.unwrap, run.network, stored);
    return stored;
  }

  private generateCandidates(
    unwrap: import('../core/unwrap.js').UnwrapResult,
    network: import('../core/branchcuts.js').BranchCutNetwork,
    artifacts: DerivedArtifact[]
  ): void {
    const unwrapArtifact = artifacts.find((a) => a.kind === 'unwrapped_phase');
    const cutArtifact = artifacts.find((a) => a.kind === 'branch_cut_network');
    const baseSources: SourceRef[] = [
      ...(unwrapArtifact ? unwrapArtifact.sources : []),
      ...(cutArtifact ? [cutArtifact.sources[0]!] : [])
    ];
    // Region-level whole-cycle candidates (multi-valued when several legal offsets exist).
    for (const offset of unwrap.regionOffsets) {
      const region = unwrap.regions.find((r) => r.regionId === offset.regionId)!;
      for (const cycles of offset.legalOffsets) {
        const id = `cand_region_${offset.regionId}_${cycles >= 0 ? 'p' : 'm'}${Math.abs(cycles)}_${unwrapArtifact?.ref.sha256.slice(0, 6) ?? 'x'}`;
        this.insertCandidateIfNew(id, {
          target: `region:${offset.regionId}`,
          targetType: 'region',
          offsetCycles: cycles,
          treePath: region.treePath,
          cycleResiduals: Object.fromEntries(
            region.cycles.map((loop) => [loop.loopId, loop.fraction])
          ),
          sources: baseSources
        });
      }
    }
    // Cut-edge candidates: explicit integer offsets; unresolved edges keep every legal value.
    for (const edge of network.edges) {
      const offsets = edge.legalOffsets.length ? edge.legalOffsets : edge.offsetCycles === null ? [-1, 0, 1] : [edge.offsetCycles];
      for (const cycles of offsets) {
        const id = `cand_edge_${edge.id.replace(/[^0-9]/g, '_')}_${cycles >= 0 ? 'p' : 'm'}${Math.abs(cycles)}`;
        this.insertCandidateIfNew(id, {
          target: edge.id,
          targetType: 'cut_edge',
          offsetCycles: cycles,
          treePath: [],
          cycleResiduals: {},
          sources: cutArtifact ? cutArtifact.sources : baseSources
        });
      }
    }
  }

  private insertCandidateIfNew(
    id: string,
    data: {
      target: string;
      targetType: 'cut_edge' | 'region';
      offsetCycles: number;
      treePath: string[];
      cycleResiduals: Record<string, number>;
      sources: SourceRef[];
    }
  ): void {
    const exists = this.db
      .prepare('SELECT 1 FROM candidates WHERE project_id=? AND candidate_id=?')
      .get(this.projectId, id);
    if (exists) return;
    this.db
      .prepare(
        `INSERT INTO candidates(project_id,candidate_id,target,target_type,offset_cycles,status,
           tree_path,cycle_residuals,reject_reason,created_at,created_seq,sources)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        this.projectId,
        id,
        data.target,
        data.targetType,
        data.offsetCycles,
        'proposed',
        JSON.stringify(data.treePath),
        JSON.stringify(data.cycleResiduals),
        null,
        this.clock.current(),
        this.project().eventSeq,
        JSON.stringify(data.sources)
      );
    this.recordEvent(
      'CANDIDATE_RECORDED',
      'algorithm',
      { candidateId: id, target: data.target, offsetCycles: data.offsetCycles },
      data.sources
    );
  }

  listCandidates(): IntegerCandidate[] {
    const rows = this.db
      .prepare('SELECT * FROM candidates WHERE project_id=? ORDER BY created_seq, candidate_id')
      .all(this.projectId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row['candidate_id'] as string,
      target: row['target'] as string,
      targetType: row['target_type'] as IntegerCandidate['targetType'],
      offsetCycles: row['offset_cycles'] as number,
      status: row['status'] as IntegerCandidate['status'],
      treePath: JSON.parse(row['tree_path'] as string) as string[],
      cycleResiduals: JSON.parse(row['cycle_residuals'] as string) as Record<string, number>,
      rejectReason: (row['reject_reason'] as string | null) ?? undefined,
      sources: JSON.parse(row['sources'] as string) as SourceRef[],
      createdAt: row['created_at'] as number
    }));
  }

  getArtifact(id: string): DerivedArtifact | null {
    const row = this.db
      .prepare('SELECT * FROM artifacts WHERE project_id=? AND artifact_id=?')
      .get(this.projectId, id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const sourceRows = this.db
      .prepare('SELECT * FROM artifact_sources WHERE project_id=? AND artifact_id=? ORDER BY ref_order')
      .all(this.projectId, id) as Array<Record<string, unknown>>;
    return {
      id: row['artifact_id'] as string,
      kind: row['kind'] as DerivedArtifact['kind'],
      status: row['status'] as DerivedArtifact['status'],
      stale: row['stale'] === 1,
      supersededBy: (row['superseded_by'] as string | null) ?? null,
      algorithm: {
        algorithm: row['algorithm'] as string,
        algorithmVersion: row['algorithm_version'] as string,
        parameters: JSON.parse(row['parameters'] as string) as Record<string, unknown>,
        fingerprint: row['fingerprint'] as string
      },
      sources: sourceRows.map((source) => ({
        kind: source['kind'] as SourceRef['kind'],
        id: source['ref_id'] as string,
        version: (source['version'] as number | null) ?? undefined,
        sha256: source['sha256'] as string,
        summary: source['summary'] as string
      })),
      ref: { sha256: row['sha256'] as string, bytes: row['bytes'] as number },
      payload: JSON.parse(row['payload'] as string),
      createdAt: row['created_at'] as number,
      diagnostic: row['diagnostic'] ? (JSON.parse(row['diagnostic'] as string) as DerivedArtifact['diagnostic']) : undefined
    };
  }

  listArtifacts(): DerivedArtifact[] {
    const rows = this.db
      .prepare('SELECT artifact_id FROM artifacts WHERE project_id=? ORDER BY created_seq')
      .all(this.projectId) as Array<{ artifact_id: string }>;
    return rows.map((row) => this.getArtifact(row.artifact_id)!);
  }

  // -------------------------------------------------------------------------
  // Candidate rejection, local locks, conflicts, undo
  // -------------------------------------------------------------------------

  rejectCandidate(candidateId: string, reason: string, actor = 'reviewer'): void {
    const result = this.db
      .prepare('UPDATE candidates SET status=?, reject_reason=? WHERE project_id=? AND candidate_id=?')
      .run('rejected', reason, this.projectId, candidateId);
    if (result.changes === 0) throw new Error(`unknown candidate ${candidateId}`);
    this.recordEvent('CANDIDATE_REJECTED', actor, { candidateId, reason }, [
      { kind: 'decision', id: candidateId, sha256: digestOfString(reason), summary: `reject ${candidateId}` }
    ]);
  }

  lockLocal(input: {
    regionId: string;
    candidateId: string | null;
    lockedOffsetCycles: number | null;
    decision: 'accept' | 'reject' | 'adjust';
    parameterAdjustments?: Record<string, unknown>;
    note?: string;
    actor?: string;
  }): { lock: LockDecision; conflict: ConflictRecord | null } {
    const actor = input.actor ?? 'reviewer';
    // An existing ACTIVE lock on the same region with a different offset is a conflict.
    const existing = this.db
      .prepare('SELECT * FROM locks WHERE project_id=? AND region_id=? AND undone_at IS NULL')
      .all(this.projectId, input.regionId) as Array<Record<string, unknown>>;
    let conflict: ConflictRecord | null = null;
    const conflicted = existing.find(
      (row) => Number(row['locked_offset_cycles']) !== (input.lockedOffsetCycles ?? Number.NaN)
    );
    if (conflicted) {
      conflict = this.openConflict('local_lock', `Conflicting local locks for ${input.regionId}`, {
        candidates: input.candidateId ? [input.candidateId] : [],
        locks: [conflicted['lock_id'] as string]
      });
    }
    const seq = this.project().eventSeq;
    const id = `lock_${input.regionId.replace(/[^a-z0-9]/gi, '_')}_${seq + 1}`;
    const sources = this.sourcesForCandidate(input.candidateId);
    const at = this.clock.tick(1);
    this.db
      .prepare(
        `INSERT INTO locks(project_id,lock_id,region_id,candidate_id,locked_offset_cycles,decision,
           adjustments,note,actor,decided_at,undone_at,resolves_conflict_id,sources,created_seq)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        this.projectId,
        id,
        input.regionId,
        input.candidateId,
        input.lockedOffsetCycles,
        input.decision,
        JSON.stringify(input.parameterAdjustments ?? {}),
        input.note ?? '',
        actor,
        at,
        null,
        conflict?.id ?? null,
        JSON.stringify(sources),
        seq
      );
    this.recordEvent(
      'LOCK_DECIDED',
      actor,
      {
        lockId: id,
        regionId: input.regionId,
        candidateId: input.candidateId,
        lockedOffsetCycles: input.lockedOffsetCycles,
        decision: input.decision,
        adjustments: input.parameterAdjustments ?? {},
        conflictId: conflict?.id ?? null
      },
      sources
    );
    if (input.candidateId) this.setCandidateStatus(input.candidateId, 'accepted');
    return { lock: this.getLock(id)!, conflict };
  }

  private sourcesForCandidate(candidateId: string | null): SourceRef[] {
    if (!candidateId) return [];
    const row = this.db
      .prepare('SELECT sources FROM candidates WHERE project_id=? AND candidate_id=?')
      .get(this.projectId, candidateId) as { sources: string } | undefined;
    return row ? (JSON.parse(row.sources) as SourceRef[]) : [];
  }

  private setCandidateStatus(candidateId: string, status: IntegerCandidate['status']): void {
    this.db
      .prepare('UPDATE candidates SET status=? WHERE project_id=? AND candidate_id=?')
      .run(status, this.projectId, candidateId);
  }

  private openConflict(
    kind: ConflictRecord['kind'],
    description: string,
    involved: { candidates: string[]; locks: string[] }
  ): ConflictRecord {
    const seq = this.project().eventSeq;
    const id = `conflict_${kind}_${seq + 1}`;
    const at = this.clock.tick(1);
    this.db
      .prepare(
        `INSERT INTO conflicts(project_id,conflict_id,kind,status,description,involved_candidates,
           involved_locks,detected_at,resolved_at,resolution_event_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        this.projectId,
        id,
        kind,
        'open',
        description,
        JSON.stringify(involved.candidates),
        JSON.stringify(involved.locks),
        at,
        null,
        null
      );
    this.recordEvent(
      'CONFLICT_DETECTED',
      'system',
      { conflictId: id, kind, description },
      [
        ...involved.candidates.map((candidate) => ({
          kind: 'decision' as const,
          id: candidate,
          sha256: digestOfString(candidate),
          summary: candidate
        }))
      ]
    );
    return {
      id,
      kind,
      status: 'open',
      description,
      involvedCandidates: involved.candidates,
      involvedLocks: involved.locks,
      detectedAt: at,
      resolvedAt: null,
      resolutionEventId: null
    };
  }

  resolveConflict(conflictId: string, resolutionLockId: string, note: string, actor = 'reviewer'): void {
    const conflict = this.db
      .prepare('SELECT * FROM conflicts WHERE project_id=? AND conflict_id=?')
      .get(this.projectId, conflictId) as Record<string, unknown> | undefined;
    if (!conflict) throw new Error(`unknown conflict ${conflictId}`);
    const at = this.clock.tick(1);
    const event = this.recordEvent(
      'CONFLICT_RESOLVED',
      actor,
      { conflictId, resolutionLockId, note },
      [{ kind: 'decision', id: resolutionLockId, sha256: digestOfString(resolutionLockId + note), summary: `resolve ${conflictId}` }]
    );
    this.db
      .prepare('UPDATE conflicts SET status=?, resolved_at=?, resolution_event_id=? WHERE project_id=? AND conflict_id=?')
      .run('resolved', at, event.id, this.projectId, conflictId);
  }

  undoLock(lockId: string, note: string, actor = 'reviewer'): void {
    const at = this.clock.tick(1);
    const result = this.db
      .prepare('UPDATE locks SET undone_at=? WHERE project_id=? AND lock_id=? AND undone_at IS NULL')
      .run(at, this.projectId, lockId);
    if (result.changes === 0) throw new Error(`cannot undo lock ${lockId}`);
    const lock = this.getLock(lockId)!;
    if (lock.candidateId) this.setCandidateStatus(lock.candidateId, 'proposed');
    this.recordEvent('LOCK_DECIDED', actor, {
      lockId,
      undo: true,
      note,
      regionId: lock.regionId
    }, [
      { kind: 'decision', id: lockId, sha256: digestOfString(lockId + 'undo' + at), summary: `undo ${lockId}` }
    ]);
  }

  listLocks(): LockDecision[] {
    const rows = this.db
      .prepare('SELECT * FROM locks WHERE project_id=? ORDER BY created_seq')
      .all(this.projectId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.hydrateLock(row));
  }

  getLock(id: string): LockDecision | null {
    const row = this.db
      .prepare('SELECT * FROM locks WHERE project_id=? AND lock_id=?')
      .get(this.projectId, id) as Record<string, unknown> | undefined;
    return row ? this.hydrateLock(row) : null;
  }

  private hydrateLock(row: Record<string, unknown>): LockDecision {
    return {
      id: row['lock_id'] as string,
      regionId: row['region_id'] as string,
      candidateId: (row['candidate_id'] as string | null) ?? null,
      lockedOffsetCycles: (row['locked_offset_cycles'] as number | null) ?? null,
      decision: row['decision'] as LockDecision['decision'],
      parameterAdjustments: JSON.parse(row['adjustments'] as string) as Record<string, unknown>,
      note: row['note'] as string,
      actor: row['actor'] as string,
      decidedAt: row['decided_at'] as number,
      undoneAt: (row['undone_at'] as number | null) ?? null,
      resolvesConflictId: (row['resolves_conflict_id'] as string | null) ?? null,
      sources: JSON.parse(row['sources'] as string) as SourceRef[]
    };
  }

  listConflicts(): ConflictRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM conflicts WHERE project_id=? ORDER BY detected_at')
      .all(this.projectId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row['conflict_id'] as string,
      kind: row['kind'] as ConflictRecord['kind'],
      status: row['status'] as ConflictRecord['status'],
      description: row['description'] as string,
      involvedCandidates: JSON.parse(row['involved_candidates'] as string) as string[],
      involvedLocks: JSON.parse(row['involved_locks'] as string) as string[],
      detectedAt: row['detected_at'] as number,
      resolvedAt: (row['resolved_at'] as number | null) ?? null,
      resolutionEventId: (row['resolution_event_id'] as string | null) ?? null
    }));
  }

  addCutEdit(input: {
    edgeId: string;
    action: 'add' | 'remove' | 'force_offset';
    integerOffsetCycles?: number;
    reason: string;
    actor?: 'human' | 'algorithm';
  }): RawVersion {
    const lineage: RawKind = 'cut_edit_history';
    const latest = this.listRawVersions(lineage).at(-1);
    const edits = latest && latest.payload.kind === 'cut_edit_history' ? latest.payload.edits.slice() : [];
    edits.push({
      edgeId: input.edgeId,
      action: input.action,
      integerOffsetCycles: input.integerOffsetCycles,
      reason: input.reason,
      actor: input.actor ?? 'human'
    });
    return this.submitRaw({
      kind: lineage,
      payload: { kind: lineage, edits },
      submittedBy: input.actor ?? 'human',
      note: `cut edit ${input.action} ${input.edgeId}`
    });
  }

  // -------------------------------------------------------------------------
  // Provenance: every query returns referenced versions + content summaries.
  // Missing or mismatched references are reported corrupt, never latest.
  // -------------------------------------------------------------------------

  private resolveRef(ref: SourceRef): { found: boolean; summary: string } {
    if (ref.kind === 'raw_version') {
      const match = /^(.+)@v(\d+)$/.exec(ref.id);
      if (!match) return { found: false, summary: 'malformed raw ref' };
      const lineage = match[1] as RawKind;
      const version = Number(match[2]);
      const raw = this.getRawVersion(lineage, version);
      if (!raw) return { found: false, summary: 'missing raw version' };
      if (raw.ref.sha256 !== ref.sha256) return { found: false, summary: 'digest mismatch' };
      return { found: true, summary: summaryOf(raw.payload) };
    }
    if (ref.kind === 'artifact') {
      const artifact = this.getArtifact(ref.id);
      if (!artifact) return { found: false, summary: 'missing artifact' };
      if (ref.sha256 && artifact.ref.sha256 !== ref.sha256) {
        return { found: false, summary: 'digest mismatch' };
      }
      return { found: true, summary: artifact.kind };
    }
    if (ref.kind === 'event') {
      const event = this.getEvent(ref.id);
      return event ? { found: true, summary: event.type } : { found: false, summary: 'missing event' };
    }
    const candidate = this.db
      .prepare('SELECT 1 FROM candidates WHERE project_id=? AND candidate_id=?')
      .get(this.projectId, ref.id);
    if (candidate) return { found: true, summary: 'candidate' };
    const lock = this.db
      .prepare('SELECT 1 FROM locks WHERE project_id=? AND lock_id=?')
      .get(this.projectId, ref.id);
    if (lock) return { found: true, summary: 'lock decision' };
    return { found: false, summary: 'missing decision' };
  }

  entityView(id: string) {
    const rawMatch = /^(.+)@v(\d+)$/.exec(id);
    if (rawMatch) {
      const lineage = rawMatch[1] as RawKind;
      const version = Number(rawMatch[2]);
      const raw = this.getRawVersion(lineage, version);
      if (!raw) {
        return {
          id,
          kind: lineage,
          version,
          status: 'corrupt',
          corrupted: true,
          corruptionReason: 'referenced raw version is missing — corrupt, no latest fallback',
          references: []
        };
      }
      return {
        id,
        kind: lineage,
        version,
        status: 'raw',
        summary: summaryOf(raw.payload),
        contentRef: raw.ref,
        references: [],
        parentVersion: raw.parentVersion,
        createdAt: raw.recordedAt
      };
    }
    const artifact = this.getArtifact(id);
    if (artifact) {
      const corruption = this.checkReferences(artifact.sources);
      return {
        id,
        kind: artifact.kind,
        version: null,
        status: artifact.status,
        stale: artifact.stale,
        summary: artifact.kind,
        contentRef: artifact.ref,
        references: artifact.sources,
        algorithm: artifact.algorithm,
        corrupted: corruption.corrupted,
        corruptionReason: corruption.reason,
        diagnostic: artifact.diagnostic ?? null,
        payload: artifact.payload,
        createdAt: artifact.createdAt
      };
    }
    const candidateRow = this.db
      .prepare('SELECT * FROM candidates WHERE project_id=? AND candidate_id=?')
      .get(this.projectId, id) as Record<string, unknown> | undefined;
    if (candidateRow) {
      const sources = JSON.parse(candidateRow['sources'] as string) as SourceRef[];
      const corruption = this.checkReferences(sources);
      return {
        id,
        kind: 'integer_candidate',
        version: null,
        status: candidateRow['status'],
        summary: `${candidateRow['target']} offset ${candidateRow['offset_cycles']} cycles`,
        contentRef: contentRef({ target: candidateRow['target'], offset: candidateRow['offset_cycles'] }),
        references: sources,
        corrupted: corruption.corrupted,
        corruptionReason: corruption.reason,
        createdAt: candidateRow['created_at']
      };
    }
    const event = this.getEvent(id);
    if (event) {
      const corruption = this.checkReferences(event.references);
      return {
        id,
        kind: 'event',
        version: event.seq,
        status: 'event',
        summary: event.type,
        contentRef: contentRef(event.payload),
        references: event.references,
        corrupted: corruption.corrupted,
        corruptionReason: corruption.reason,
        createdAt: event.at,
        payload: event.payload
      };
    }
    throw new CorruptReferenceError(`unknown entity ${id}`);
  }

  private checkReferences(refs: SourceRef[]): { corrupted: boolean; reason: string | null } {
    for (const ref of refs) {
      const result = this.resolveRef(ref);
      if (!result.found) {
        return { corrupted: true, reason: `${ref.id}: ${result.summary}` };
      }
    }
    return { corrupted: false, reason: null };
  }

  /** Full integrity sweep used after import and by the archive UI. */
  verifyIntegrity(): { ok: boolean; broken: Array<{ id: string; reason: string }> } {
    const broken: Array<{ id: string; reason: string }> = [];
    for (const artifact of this.listArtifacts()) {
      const check = this.checkReferences(artifact.sources);
      if (check.corrupted) broken.push({ id: artifact.id, reason: check.reason! });
    }
    for (const event of this.listEvents()) {
      const check = this.checkReferences(event.references);
      if (check.corrupted) broken.push({ id: event.id, reason: check.reason! });
    }
    for (const candidate of this.listCandidates()) {
      const check = this.checkReferences(candidate.sources);
      if (check.corrupted) broken.push({ id: candidate.id, reason: check.reason! });
    }
    return { ok: broken.length === 0, broken };
  }

  /**
   * Time travel: state visible from an old event. Exact raw versions and
   * artifact digests referenced at that moment are restored; the newest
   * computation is never substituted for history.
   */
  stateAt(eventId: string) {
    const events = this.listEvents();
    const index = events.findIndex((event) => event.id === eventId);
    if (index === -1) throw new CorruptReferenceError(`cannot travel to unknown event ${eventId}`);
    const upTo = events.slice(0, index + 1);
    const rawAtEvent: Partial<Record<RawKind, number>> = {};
    const artifactsAtEvent = new Set<string>();
    const locks: LockDecision[] = [];
    for (const event of upTo) {
      if (event.type === 'RAW_INPUT_SUBMITTED') {
        rawAtEvent[event.payload['lineage'] as RawKind] = event.payload['version'] as number;
      }
      if (event.type === 'DERIVATION_RECORDED') {
        artifactsAtEvent.add(event.payload['artifactId'] as string);
      }
      if (event.type === 'LOCK_DECIDED') {
        const lock = this.getLock(event.payload['lockId'] as string);
        if (lock) locks.push(lock);
      }
    }
    return {
      event: events[index]!,
      rawVersions: rawAtEvent,
      artifactIds: [...artifactsAtEvent],
      locks,
      /** Restore artifact payloads by their stable ids (content addressed). */
      artifacts: [...artifactsAtEvent].map((id) => this.getArtifact(id)).filter(Boolean)
    };
  }

export { contentRef, digestOfString, rawSource, runPipeline, DEFAULT_PARAMS };
export type { PipelineParams, HistoryEvent, DerivedArtifact, IntegerCandidate, LockDecision, ConflictRecord, SourceRef };
