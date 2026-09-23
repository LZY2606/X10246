import {
  derivedEntityId,
  fingerprintParams,
  rawEntityId,
  sha256Hex,
  VirtualClock,
} from './determinism';
import type {
  CounterexampleKind,
  CutEditHistory,
  EntityEnvelope,
  EntityKind,
  EntityRef,
  LedgerEvent,
  LedgerEventType,
  RawSlot,
  ReviewLock,
} from './types';
import { CorruptionError, LedgerStore } from '../store/sqlite-store';
import { IngestFormatError, parseBundle, validateBundle } from '../ingest/bundle';
import { hashData } from '../store/sqlite-store';
import { runPipeline, type RawContext } from './pipeline';

const SLOTS: RawSlot[] = [
  'wrapped_phase',
  'signal_quality',
  'invalid_mask',
  'wavelength',
  'illumination_geometry',
  'calibration_plane',
  'cut_edit_history',
];

const SLOT_TO_KIND: Record<RawSlot, EntityKind> = {
  wrapped_phase: 'raw_wrapped_phase',
  signal_quality: 'raw_signal_quality',
  invalid_mask: 'raw_invalid_mask',
  wavelength: 'raw_wavelength',
  illumination_geometry: 'raw_illumination_geometry',
  calibration_plane: 'raw_calibration_plane',
  cut_edit_history: 'raw_cut_edit_history',
};

const SLOT_SUMMARY: Record<RawSlot, (d: unknown) => string> = {
  wrapped_phase: (d) => {
    const g = d as RawContext['wrappedPhase'];
    return `wrapped phase ${g.grid.width}x${g.grid.height} rad [${g.rangeConvention}]`;
  },
  signal_quality: (d) => {
    const g = d as RawContext['signalQuality'];
    return `amplitude/snr map ${g.grid.width}x${g.grid.height} (${g.amplitudeUnit},dB)`;
  },
  invalid_mask: (d) => {
    const g = d as RawContext['invalidMask'];
    return `mask ${g.grid.width}x${g.grid.height}, ${g.invalid.filter(Boolean).length} invalid pixels`;
  },
  wavelength: (d) => {
    const g = d as RawContext['wavelength'];
    return `lambda=${g.lambda.raw} ${g.lambda.unit} (${g.medium})`;
  },
  illumination_geometry: (d) => {
    const g = d as RawContext['geometry'];
    return `theta_i=${g.incidenceAngle.raw}, theta_o=${g.observationAngle.raw}`;
  },
  calibration_plane: (d) => {
    const g = d as RawContext['calibration'];
    return `plane ${g.a.raw}x+${g.b.raw}y+${g.c.raw}, anchors=${g.anchorPixels.length}`;
  },
  cut_edit_history: (d) => {
    const g = d as RawContext['cutHistory'];
    return `${g.edits.length} append-only cut edits`;
  },
};

export interface CommitResult {
  envelope: EntityEnvelope;
  event: LedgerEvent;
  reused: boolean;
}

export interface ViewOptions {
  atSeq?: number | null;
}

export class LedgerService {
  readonly clock: VirtualClock;
  readonly seed: number;

  constructor(
    readonly store: LedgerStore,
    opts: { epochIso?: string; seed?: number } = {}
  ) {
    this.clock = new VirtualClock(opts.epochIso ?? '2026-09-24T00:00:00.000Z', 0);
    this.seed = opts.seed ?? 20260924;
  }

  emit(type: LedgerEventType, caseId: string, payload: Record<string, unknown>): LedgerEvent {
    const seq = this.store.nextSeq();
    this.clock.advance(1);
    const event: LedgerEvent = {
      eventId: `evt-${caseId}-${seq.toString().padStart(5, '0')}`,
      seq,
      caseId,
      at: this.clock.snapshot(),
      type,
      payload,
    };
    return this.store.appendEvent(event);
  }

  /* -------------------------------- 导入 -------------------------------- */

  importCase(input: unknown): {
    caseId: string;
    committed: CommitResult[];
    warnings: number;
  } {
    const { diagnostics, bundle } = validateBundle(input);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    if (errors.length || !bundle) {
      throw new IngestFormatError(diagnostics);
    }
    const { parsed, warnings } = parseBundle(bundle);
    const caseId = bundle.caseId;
    if (this.store.meta(`case:${caseId}`)) {
      throw new Error(`case ${caseId} already exists; revise slots instead of overwriting`);
    }
    this.store.setMeta(`case:${caseId}`, bundle.label || caseId);
    this.emit('case_opened', caseId, { caseId, label: bundle.label ?? caseId });

    const committed: CommitResult[] = [];
    const rawData: Record<RawSlot, unknown> = {
      wrapped_phase: parsed.wrappedPhase,
      signal_quality: parsed.signalQuality,
      invalid_mask: parsed.invalidMask,
      wavelength: parsed.wavelength,
      illumination_geometry: parsed.geometry,
      calibration_plane: parsed.calibration,
      cut_edit_history: parsed.cutHistory,
    };
    for (const slot of SLOTS) {
      committed.push(this.commitRaw(caseId, slot, rawData[slot], 'initial lab import'));
    }
    if (warnings.length) {
      this.emit('raw_committed', caseId, {
        note: 'import carried unconverted raw quantities',
        warnings: warnings.map((w) => w.message),
      });
    }
    return { caseId, committed, warnings: warnings.length };
  }

  commitRaw(caseId: string, slot: RawSlot, data: unknown, note: string): CommitResult {
    const blobHash = hashData(data);
    const entityId = rawEntityId(caseId, slot, blobHash);
    const existing = this.store.getEntity(entityId);
    if (existing) {
      return {
        envelope: existing,
        event: this.emit('raw_committed', caseId, {
          entityId,
          version: existing.version,
          slot,
          blobHash,
          reused: true,
          note,
        }),
        reused: true,
      };
    }
    const prior = this.store.latestRawVersion(caseId, slot);
    const version = prior ? prior.version + 1 : 1;
    const envelope: EntityEnvelope = {
      entityId,
      kind: SLOT_TO_KIND[slot],
      caseId,
      slot,
      version,
      parentId: prior ? prior.entityId : null,
      blobHash,
      refs: [],
      createdAt: this.clock.snapshot(),
      data,
    };
    this.store.putEntity(envelope);
    const event = this.emit('raw_committed', caseId, {
      entityId,
      version,
      slot,
      parentId: prior ? prior.entityId : null,
      blobHash,
      immutable: true,
      note,
    });
    return { envelope, event, reused: false };
  }

  /** 尝试覆盖同一不可变版本必须被拒绝并留痕。 */
  attemptOverwrite(caseId: string, slot: RawSlot, data: unknown, reason: string): LedgerEvent {
    const current = this.store.latestRawVersion(caseId, slot);
    return this.emit('raw_revision_blocked', caseId, {
      slot,
      attemptedEntityId: current?.entityId ?? null,
      reason,
      wouldBeHash: hashData(data).slice(0, 16),
      policy: 'raw inputs are append-only; submit a revision as a new version',
    });
  }

  /** 修订单个槽位：产生新版本并保留父版本关系。 */
  reviseSlot(caseId: string, slot: RawSlot, data: unknown, note: string): CommitResult {
    return this.commitRaw(caseId, slot, data, `revision: ${note}`);
  }

  /* -------------------------------- 派生 -------------------------------- */

  rawContext(caseId: string, atSeq?: number | null): RawContext {
    const pick = (slot: RawSlot) => {
      const versions = this.store.rawVersions(caseId, slot);
      const eligible = atSeq == null ? versions : versions.filter((v) => v.createdAt.tick <= tickAtSeq(this.store, caseId, atSeq));
      const env = eligible[eligible.length - 1];
      if (!env) throw new Error(`missing raw slot ${slot} for case ${caseId}${atSeq != null ? ` at seq ${atSeq}` : ''}`);
      return env;
    };
    return {
      wrappedPhase: pick('wrapped_phase').data as RawContext['wrappedPhase'],
      signalQuality: pick('signal_quality').data as RawContext['signalQuality'],
      invalidMask: pick('invalid_mask').data as RawContext['invalidMask'],
      wavelength: pick('wavelength').data as RawContext['wavelength'],
      geometry: pick('illumination_geometry').data as RawContext['geometry'],
      calibration: pick('calibration_plane').data as RawContext['calibration'],
      cutHistory: pick('cut_edit_history').data as RawContext['cutHistory'],
    };
  }

  rawEnvelopeMap(caseId: string, atSeq?: number | null) {
    return {
      wrappedPhase: this.effectiveRaw(caseId, 'wrapped_phase', atSeq),
      signalQuality: this.effectiveRaw(caseId, 'signal_quality', atSeq),
      invalidMask: this.effectiveRaw(caseId, 'invalid_mask', atSeq),
      wavelength: this.effectiveRaw(caseId, 'wavelength', atSeq),
      geometry: this.effectiveRaw(caseId, 'illumination_geometry', atSeq),
      calibration: this.effectiveRaw(caseId, 'calibration_plane', atSeq),
      cutHistory: this.effectiveRaw(caseId, 'cut_edit_history', atSeq),
    };
  }

  private effectiveRaw(caseId: string, slot: RawSlot, atSeq?: number | null): EntityEnvelope {
    const versions = this.store.rawVersions(caseId, slot);
    const eligible =
      atSeq == null
        ? versions
        : versions.filter((v) => v.createdAt.tick <= tickAtSeq(this.store, caseId, atSeq));
    const env = eligible[eligible.length - 1];
    if (!env) throw new Error(`missing raw slot ${slot}`);
    return env;
  }

  private toRef(env: EntityEnvelope): EntityRef {
    const slot = env.slot;
    const summary = slot ? SLOT_SUMMARY[slot](env.data) : `${env.kind}#${env.version}`;
    return { entityId: env.entityId, version: env.version, kind: env.kind, summary };
  }

  /**
   * 运行当前原始上下文的整条派生流水线并把每步作为内容寻址实体提交。
   * 返回每个实体以及它是否对当前输入是新鲜的。
   */
  commitDerivedPipeline(caseId: string, note = 'derived pipeline run') {
    const raws = this.rawEnvelopeMap(caseId);
    const context: RawContext = {
      wrappedPhase: raws.wrappedPhase.data as RawContext['wrappedPhase'],
      signalQuality: raws.signalQuality.data as RawContext['signalQuality'],
      invalidMask: raws.invalidMask.data as RawContext['invalidMask'],
      wavelength: raws.wavelength.data as RawContext['wavelength'],
      geometry: raws.geometry.data as RawContext['geometry'],
      calibration: raws.calibration.data as RawContext['calibration'],
      cutHistory: raws.cutHistory.data as RawContext['cutHistory'],
    };
    const pipeline = runPipeline(context, this.seed);
    const rawRefs = Object.values(raws).map((e) => this.toRef(e));
    const refsHash = sha256Hex(rawRefs.map((r) => `${r.entityId}#${r.version}`).join('|'));

    const committed: { envelope: EntityEnvelope; reused: boolean; stale: false }[] = [];
    const stepEntityIds: Partial<Record<string, EntityEnvelope>> = {};

    for (const step of pipeline.steps) {
      const fp = fingerprintParams(step.params);
      const entityId = derivedEntityId(step.kind, caseId, step.algoVersion, fp, refsHash);
      const existing = this.store.getEntity(entityId);
      if (existing) {
        committed.push({ envelope: existing, reused: true, stale: false });
        stepEntityIds[step.kind] = existing;
        continue;
      }
      const envelope: EntityEnvelope = {
        entityId,
        kind: step.kind,
        caseId,
        version: 1,
        parentId: null,
        blobHash: hashData(step.data),
        refs: rawRefs,
        provenance: { algoVersion: step.algoVersion, paramsFingerprint: fp, seed: this.seed },
        createdAt: this.clock.snapshot(),
        data: step.data,
      };
      this.store.putEntity(envelope);
      this.emit('derived_committed', caseId, {
        entityId,
        kind: step.kind,
        algoVersion: step.algoVersion,
        paramsFingerprint: fp,
        refs: rawRefs.map((r) => ({ entityId: r.entityId, version: r.version })),
        note,
      });
      committed.push({ envelope, reused: false, stale: false });
      stepEntityIds[step.kind] = envelope;
    }

    // 为每个合法候选生成一条高度转换链
    const candidateSetEnv = stepEntityIds['integer_candidate_set'] as EntityEnvelope;
    const candidateSet = candidateSetEnv.data as {
      candidates: { candidateId: string }[];
    };
    const heights: EntityEnvelope[] = [];
    for (let i = 0; i < candidateSet.candidates.length; i++) {
      const h = pipeline.heightFor(i);
      if (!h) continue;
      const fp = fingerprintParams({ ...h.params, candidateIndex: i });
      const entityId = derivedEntityId(
        h.kind,
        caseId,
        h.algoVersion,
        fp,
        sha256Hex(refsHash + '|' + candidateSet.candidates[i].candidateId)
      );
      const existing = this.store.getEntity(entityId);
      if (existing) {
        heights.push(existing);
        continue;
      }
      const envelope: EntityEnvelope = {
        entityId,
        kind: 'height_field',
        caseId,
        version: 1,
        parentId: null,
        blobHash: hashData(h.data),
        refs: [...rawRefs, this.toRef(candidateSetEnv)],
        provenance: { algoVersion: h.algoVersion, paramsFingerprint: fp, seed: this.seed },
        createdAt: this.clock.snapshot(),
        data: h.data,
      };
      this.store.putEntity(envelope);
      this.emit('derived_committed', caseId, {
        entityId,
        kind: 'height_field',
        algoVersion: h.algoVersion,
        paramsFingerprint: fp,
        candidateId: candidateSet.candidates[i].candidateId,
        note: `height conversion chain for ${candidateSet.candidates[i].candidateId}`,
      });
      heights.push(envelope);
    }

    return { committed, heights, rawRefs, refsHash };
  }

  /* ------------------------------ 候选裁定 ------------------------------ */

  ruleCandidate(
    caseId: string,
    candidateEntityId: string,
    candidateId: string,
    decision: 'accept' | 'reject',
    reason: string,
    author = 'reviewer'
  ): { entity: EntityEnvelope; event: LedgerEvent } {
    const setEnv = this.store.resolveEntity(candidateEntityId);
    const data = setEnv.data as {
      candidates: Array<{ candidateId: string; status: string; rejectReason?: string }>;
    };
    const candidate = data.candidates.find((c) => c.candidateId === candidateId);
    if (!candidate) throw new Error(`candidate ${candidateId} not found in ${candidateEntityId}`);
    const next = structuredClone(data);
    const target = next.candidates.find((c) => c.candidateId === candidateId)!;
    if (decision === 'accept') {
      for (const c of next.candidates) {
        if (c.status === 'accepted') c.status = 'legal';
      }
      target.status = 'accepted';
      delete target.rejectReason;
    } else {
      if (target.status === 'accepted') target.status = 'legal';
      target.status = 'rejected';
      target.rejectReason = reason;
    }
    const fp = fingerprintParams({ decision, candidateId, reason, author });
    const entityId = `${candidateEntityId}--ruling-${setEnv.version}-${fp.slice(-8)}`;
    const envelope: EntityEnvelope = {
      entityId,
      kind: 'integer_candidate_set',
      caseId,
      version: setEnv.version + 1,
      parentId: setEnv.entityId,
      blobHash: hashData(next),
      refs: [this.toRef(setEnv)],
      provenance: { paramsFingerprint: fp },
      createdAt: this.clock.snapshot(),
      data: next,
    };
    this.store.putEntity(envelope);
    const event = this.emit('candidate_ruled', caseId, {
      candidateSetEntityId: entityId,
      candidateId,
      decision,
      reason,
      author,
      supersedes: setEnv.entityId,
    });
    return { entity: envelope, event };
  }

  /* ------------------------------ 局部锁定 ------------------------------ */

  acquireLock(
    caseId: string,
    pixels: number[],
    candidateId: string | null,
    lockedValue: string,
    interpretation: string,
    author = 'reviewer'
  ): { lock: ReviewLock; entity: EntityEnvelope; event: LedgerEvent; conflict: boolean } {
    const existing = this.activeLocks(caseId).filter((l) => l.pixels.some((p) => pixels.includes(p)));
    const conflict = existing.length > 0;
    if (conflict) {
      this.emit('lock_conflict', caseId, {
        pixels,
        candidateId,
        conflicting: existing.map((l) => l.lockId),
        author,
        policy: 'release or reject the prior local lock first',
      });
    }
    const seq = this.store.nextSeq();
    const lock: ReviewLock = {
      lockId: `lock-${seq.toString().padStart(4, '0')}`,
      pixels: [...pixels].sort((a, b) => a - b),
      candidateId,
      lockedValue,
      interpretation,
      status: conflict ? 'conflict' : 'active',
    };
    const envelope: EntityEnvelope = {
      entityId: `lock:${caseId}:${lock.lockId}`,
      kind: 'review_lock',
      caseId,
      version: 1,
      parentId: null,
      blobHash: hashData(lock),
      refs: [],
      createdAt: this.clock.snapshot(),
      data: lock,
    };
    this.store.putEntity(envelope);
    const event = this.emit('lock_acquired', caseId, {
      lockId: lock.lockId,
      pixels: lock.pixels,
      candidateId,
      lockedValue,
      interpretation,
      conflict,
      author,
    });
    return { lock, entity: envelope, event, conflict };
  }

  releaseLock(caseId: string, lockId: string, author = 'reviewer'): LedgerEvent {
    const env = this.store.getEntity(`lock:${caseId}:${lockId}`);
    if (!env) throw new Error(`unknown lock ${lockId}`);
    const lock = env.data as ReviewLock;
    const released: ReviewLock = { ...lock, status: 'released' };
    this.store.putEntity({ ...env, blobHash: hashData(released), data: released });
    return this.emit('lock_released', caseId, { lockId, author });
  }

  activeLocks(caseId: string, atSeq?: number | null): ReviewLock[] {
    const entities = this.store
      .entities(caseId)
      .filter((e) => e.kind === 'review_lock')
      .filter((e) => atSeq == null || e.createdAt.tick <= tickAtSeq(this.store, caseId, atSeq));
    const latest = new Map<string, EntityEnvelope>();
    for (const e of entities) latest.set(e.entityId, e);
    return [...latest.values()]
      .map((e) => e.data as ReviewLock)
      .filter((l) => l.status === 'active' || l.status === 'conflict');
  }

  /* ------------------------------ 切口编辑 ------------------------------ */

  appendCutEdit(
    caseId: string,
    edit: Omit<CutEditHistory['edits'][number], 'editId'>,
    note: string
  ): CommitResult {
    const current = this.store.latestRawVersion(caseId, 'cut_edit_history');
    if (!current) throw new Error('cut_edit_history missing');
    const history = current.data as CutEditHistory;
    const nextHistory: CutEditHistory = {
      edits: [...history.edits, { ...edit, editId: `manual-${history.edits.length + 1}` }],
    };
    const result = this.commitRaw(caseId, 'cut_edit_history', nextHistory, note);
    this.emit('cut_edited', caseId, {
      edit: nextHistory.edits[nextHistory.edits.length - 1],
      rawEntityId: result.envelope.entityId,
      version: result.envelope.version,
      note,
    });
    return result;
  }

  /* ------------------------------ 人工决定 ------------------------------ */

  recordDecision(
    caseId: string,
    subject: { kind: EntityKind; entityId: string; version: number },
    verdict: 'accepted' | 'rejected' | 'adjusted',
    rationale: string,
    parameterChange?: Record<string, unknown>,
    author = 'reviewer'
  ): { entity: EntityEnvelope; event: LedgerEvent } {
    const seq = this.store.nextSeq();
    const data = {
      decisionId: `decision-${seq.toString().padStart(4, '0')}`,
      subject,
      verdict,
      rationale,
      parameterChange: parameterChange ?? null,
      author,
      undone: false,
    };
    const envelope: EntityEnvelope = {
      entityId: `decision:${caseId}:${data.decisionId}`,
      kind: 'decision_record',
      caseId,
      version: 1,
      parentId: null,
      blobHash: hashData(data),
      refs: [{ ...subject, summary: `decision subject ${subject.kind}` }],
      createdAt: this.clock.snapshot(),
      data,
    };
    this.store.putEntity(envelope);
    const event = this.emit('decision_recorded', caseId, { ...data });
    return { entity: envelope, event };
  }

  undoDecision(caseId: string, decisionId: string, reason: string): LedgerEvent {
    const env = this.store.getEntity(`decision:${caseId}:${decisionId}`);
    if (!env) throw new Error(`unknown decision ${decisionId}`);
    const data = { ...(env.data as Record<string, unknown>), undone: true };
    this.store.putEntity({ ...env, blobHash: hashData(data), data });
    return this.emit('decision_undone', caseId, { decisionId, reason });
  }

  /* ------------------------------ 视图 / 回放 ----------------------------- */

  /**
   * 复核视图：给定事件序列号恢复当时可见的原始版本、派生结果、锁定与决定。
   * 历史视图绝不被最新计算覆盖。
   */
  view(caseId: string, options: ViewOptions = {}): ReviewView {
    const atSeq = options.atSeq ?? null;
    const raws = SLOTS.map((slot) => this.effectiveRaw(caseId, slot, atSeq));
    const allEntities = this.store
      .entities(caseId)
      .filter((e) => atSeq == null || e.createdAt.tick <= tickAtSeq(this.store, caseId, atSeq));

    const derivedKinds: EntityKind[] = [
      'quality_map',
      'residue_map',
      'cut_network',
      'unwrap_tree',
      'cycle_residual',
      'integer_candidate_set',
      'height_field',
    ];

    const currentRawRefs = raws.map((e) => `${e.entityId}#${e.version}`).sort();
    const derived = allEntities.filter((e) => derivedKinds.includes(e.kind));
    const withFreshness = derived.map((entity) => ({ entity, stale: isStale(entity, currentRawRefs) }));

    const locks = allEntities
      .filter((e) => e.kind === 'review_lock')
      .map((e) => e.data as ReviewLock)
      .filter((l) => l.status !== 'released');
    const decisions = allEntities
      .filter((e) => e.kind === 'decision_record')
      .map((e) => e.data as LedgerDecisionData);

    const events = this.store
      .events(caseId)
      .filter((e) => atSeq == null || e.seq <= atSeq);

    return {
      caseId,
      atSeq,
      raws: raws.map((e) => ({ envelope: e, summary: this.toRef(e).summary })),
      derived: withFreshness,
      locks,
      decisions,
      events,
      currentRawRefs: raws.map((e) => this.toRef(e)),
    };
  }

  currentDerived(caseId: string, kind: EntityKind): EntityEnvelope | null {
    const fresh = this.view(caseId).derived.filter((d) => d.entity.kind === kind && !d.stale);
    return fresh[0]?.entity ?? null;
  }

  /** 局部输入变化后，只让引用了旧版本的派生结果过期。 */
  staleness(caseId: string): { entity: EntityEnvelope; stale: boolean }[] {
    return this.view(caseId).derived;
  }

  query(entityId: string, version?: number): EntityEnvelope {
    return this.store.resolveEntity(entityId, version);
  }

  history(entityId: string): EntityEnvelope[] {
    return this.store.entityHistory(entityId);
  }

  events(caseId: string): LedgerEvent[] {
    return this.store.events(caseId);
  }

  assertIntegrity(caseId: string): void {
    const broken = this.store.verifyIntegrity(caseId);
    if (broken.length) {
      const first = broken[0];
      throw new CorruptionError(first.missing, first.entityId);
    }
  }

  markCounterexample(
    caseId: string,
    kind: CounterexampleKind,
    segment: { scenarioId: string; minimalInput: string; combinedInput: string; sharedBlobHash: string },
    verdict: { status: string; adopted: boolean; evidenceEntityIds: string[] }
  ): LedgerEvent {
    return this.emit('decision_recorded', caseId, {
      counterexample: kind,
      scenarioId: segment.scenarioId,
      minimalInputEntityId: segment.minimalInput,
      combinedInputEntityId: segment.combinedInput,
      sharedBlobHash: segment.sharedBlobHash,
      machineReadable: true,
      verdict,
      rule: COUNTEREXAMPLE_RULES[kind],
    });
  }
}

/* ------------------------------- 辅助与类型 ------------------------------- */

export interface LedgerDecisionData {
  decisionId: string;
  subject: { kind: EntityKind; entityId: string; version: number };
  verdict: 'accepted' | 'rejected' | 'adjusted';
  rationale: string;
  undone: boolean;
  author: string;
}

export interface ReviewView {
  caseId: string;
  atSeq: number | null;
  raws: { envelope: EntityEnvelope; summary: string }[];
  derived: { entity: EntityEnvelope; stale: boolean }[];
  locks: ReviewLock[];
  decisions: LedgerDecisionData[];
  events: LedgerEvent[];
  currentRawRefs: EntityRef[];
}

export const COUNTEREXAMPLE_RULES: Record<CounterexampleKind, string> = {
  'phase-boundary': 'a true fringe crossing must add one integer cycle across the boundary; never rescale the wrapped value in place',
  'low-amplitude-hole': 'pixels below the amplitude/snr threshold or masked keep k=null: never guess phase through a hole',
  'multi-connected': 'disconnected valid regions get independent unwrap trees; relative integer offset is not observable by data alone',
  'cycle-nonclosure': 'a plaquette with nonzero charge or an open graph cycle must keep its residual; a branch cut carries an explicit jump',
  'wavelength-revision': 'a new wavelength version only invalidates height chains; wrapped phase, quality and residues stay valid',
  'integer-ambiguity': 'when multiple integer fields are legal, retain every candidate with reject reasons; do not silently pick one',
  'lock-conflict': 'overlapping local locks with different interpretations are conflicts and remain visible until released or rejected',
};

function isStale(entity: EntityEnvelope, currentRawRefs: string[]): boolean {
  // 引用的每个 raw id#version 必须仍是当前生效的原始内容，否则该派生结果过期
  for (const ref of entity.refs.filter((r) => r.kind.startsWith('raw_'))) {
    if (!currentRawRefs.includes(`${ref.entityId}#${ref.version}`)) return true;
  }
  return false;
}

function tickAtSeq(store: LedgerStore, caseId: string, seq: number): number {
  const events = store.events(caseId).filter((e) => e.seq <= seq);
  return events.length ? events[events.length - 1].at.tick : 0;
}

