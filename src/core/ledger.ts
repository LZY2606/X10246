/**
 * 复核台账：事件溯源状态机。
 * 关键规则：
 *  - 原始输入只追加、不可覆盖；版本之间用 parentVersionId 串链；
 *  - 派生分析记录直接来源（bundle/wavelength/params 三版本），局部改动只使依赖结果过期；
 *  - 过期结果仍可查看，但 current=false，不能冒充当前结果；
 *  - 局部锁定冲突显式记录，解决（保留/替换）也写入历史；
 *  - 撤销写入 undo 事件，不删除旧事件；
 *  - 引用缺失 -> CorruptedLedgerError，绝不回退到“最新版”；
 *  - 支持在任意 seq 重放，恢复当时依赖版本与可见结论。
 */
import type { Clock } from '../shared/clock.ts';
import { RealClock } from '../shared/clock.ts';
import { contentId, contentHash } from '../shared/ids.ts';
import { assembleBundle } from '../domain/units.ts';
import { buildHeight } from '../domain/height.ts';
import { buildQuality, runUnwrap } from '../domain/unwrap.ts';
import { wavelengthV2 } from '../domain/fixtures.ts';
import type { InputBundle, RawGrid } from '../domain/vocabulary.ts';
import type { AnalysisParams } from '../domain/analysis-types.ts';
import { DEFAULT_PARAMS } from '../domain/analysis-types.ts';
import type {
  AnalysisProducedPayload,
  AnalysisRecord,
  AnyEvent,
  CandidateAdjudication,
  ConflictRecord,
  DecisionRecord,
  EventEnvelope,
  LockRecord,
} from './events.ts';
import {
  DecisionUndonePayload,
  InputVersionPayload,
  LocalLockSetPayload,
  LockConflictPayload,
  ParameterRevisedPayload,
  SourcePatchedPayload,
  ViewRestoredPayload,
} from './events.ts';

export class CorruptedLedgerError extends Error {
  constructor(
    readonly missingRef: string,
    readonly fromEventSeq: number,
  ) {
    super(`台账引用损坏：事件 #${fromEventSeq} 引用的 ${missingRef} 不存在（不允许回退到最新版）`);
    this.name = 'CorruptedLedgerError';
  }
}

export interface LedgerStore {
  loadEvents(projectId: string): AnyEvent[];
  appendEvent(evt: AnyEvent): void;
  putRaw(raw: { rawContentId: string; kind: string; bytes: Uint8Array; mediaType: string; createdAt: string }): void;
  getRaw(rawContentId: string): Uint8Array | null;
  listRaw(): { rawContentId: string; kind: string; mediaType: string }[];
  allProjectIds(): string[];
}

function depKey(bundleVersionId: string, wavelengthVersionId: string, parameterSetId: string): string {
  return `${bundleVersionId}|${wavelengthVersionId}|${parameterSetId}`;
}

function requireRef<T>(value: T | null | undefined, ref: string, seq: number): T {
  if (value === null || value === undefined) throw new CorruptedLedgerError(ref, seq);
  return value;
}

export interface LedgerOptions {
  clock?: Clock;
  actor?: string;
  seed?: number;
}

export class Ledger {
  private events: AnyEvent[] = [];
  readonly projectId: string;
  private seqCounter = 0;
  private readonly clock: Clock;
  private readonly actor: string;
  private readonly seed: number;
  private restoreSeq: number | null = null;

  constructor(
    projectId: string,
    private readonly store: LedgerStore,
    opts: LedgerOptions = {},
  ) {
    this.projectId = projectId;
    this.clock = opts.clock ?? new RealClock();
    this.actor = opts.actor ?? 'lab-reviewer';
    this.seed = opts.seed ?? 20260924;
  }

  static create(store: LedgerStore, name: string, caseTag: string, opts: LedgerOptions = {}): Ledger {
    const seed = opts.seed ?? 20260924;
    const projectId = `proj_${contentHash({ name, caseTag, seed })}`;
    const ledger = new Ledger(projectId, store, opts);
    ledger.append('project-created', { name, caseTag, seed }, '建立复核项目', null);
    return ledger;
  }

  static open(store: LedgerStore, projectId: string, opts: LedgerOptions = {}): Ledger {
    const events = store.loadEvents(projectId);
    const ledger = new Ledger(projectId, store, opts);
    ledger.hydrate(events);
    return ledger;
  }

  private hydrate(events: AnyEvent[]): void {
    let maxSeq = 0;
    for (const evt of events) {
      this.validateRefs(evt);
      maxSeq = Math.max(maxSeq, evt.seq);
    }
    this.events = events.slice().sort((a, b) => a.seq - b.seq);
    this.seqCounter = maxSeq;
  }

  private append<T extends AnyEvent['payload']>(
    type: AnyEvent['type'],
    payload: T,
    reason: string,
    parentSeq: number | null = this.events.length ? this.events[this.events.length - 1]!.seq : null,
  ): EventEnvelope<T> {
    this.seqCounter += 1;
    const seq = this.seqCounter;
    const at = this.clock.now();
    const eventId = `evt_${String(seq).padStart(6, '0')}_${contentHash({ seq, type, payload })}`;
    const evt: EventEnvelope<T> = {
      eventId,
      seq,
      projectId: this.projectId,
      type,
      at,
      actor: this.actor,
      reason,
      payload,
      parentSeq,
    };
    this.validateRefs(evt as AnyEvent);
    this.store.appendEvent(evt as unknown as AnyEvent);
    this.events.push(evt as unknown as AnyEvent);
    return evt;
  }

  get headSeq(): number {
    return this.seqCounter;
  }

  eventLog(): AnyEvent[] {
    return this.events.slice();
  }
}


  // ---------- 输入：只追加、不可覆盖，版本父子链 ----------

  /** 提交一个不可变输入束（包裹相位/振幅/遮罩/波长/几何/标定/切口历史）。 */
  submitBundle(bundle: InputBundle, reason = '光学实验室导入原始干涉帧与标定帧', parentBundleVersionId: string | null = null): string {
    const bytes = new TextEncoder().encode(JSON.stringify(bundle));
    const rawId = contentId('raw', bytes);
    if (this.store.getRaw(rawId) === null) {
      this.store.putRaw({ rawContentId: rawId, kind: 'bundle', bytes, mediaType: 'application/json', createdAt: this.clock.now() });
    }
    const versionId = parentBundleVersionId
      ? `ver_bundle_${contentHash({ rawId, parent: parentBundleVersionId })}`
      : `ver_bundle_${contentHash(rawId)}`;
    const existing = this.events.find(
      (e) => (e.type === 'input-submitted' || e.type === 'source-patched')
        && ((e.payload as InputVersionPayload | SourcePatchedPayload).versionId === versionId
          || (e.payload as SourcePatchedPayload).bundleVersionId === versionId),
    );
    if (existing) return versionId;

    const payload: InputVersionPayload = {
      rawContentId: rawId,
      inputKind: 'bundle',
      versionId,
      parentVersionId: parentBundleVersionId,
      immutable: true,
      label: `原始输入束 ${bundle.bundleId}（${bundle.tiles.length} 个不可变瓦片）`,
      contentDigest: rawId,
      bundle,
    };
    this.append('input-submitted', payload, reason);
    return versionId;
  }

  /** 波长修订（如 632.8nm -> 633.0nm）：新版本，旧高度链不覆盖。 */
  reviseWavelength(parentBundleVersionId: string, valueNm: number, rawRepresentation: string, reason: string): string {
    const parentBundle = this.bundleAt(parentBundleVersionId);
    const revised: InputBundle = {
      ...parentBundle,
      wavelength: { value: valueNm, unit: 'nm', medium: parentBundle.wavelength.medium, rawRepresentation },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(revised));
    const rawId = contentId('raw', bytes);
    if (this.store.getRaw(rawId) === null) {
      this.store.putRaw({ rawContentId: rawId, kind: 'bundle', bytes, mediaType: 'application/json', createdAt: this.clock.now() });
    }
    const versionId = `ver_bundle_${contentHash({ rawId, parent: parentBundleVersionId })}`;
    this.append('source-patched', {
      bundleVersionId: versionId,
      parentBundleVersionId,
      rawContentId: rawId,
      changedTileIds: [],
      patchNote: `波长版本变更：${parentBundle.wavelength.value}nm -> ${valueNm}nm`,
      bundle: revised,
    } satisfies SourcePatchedPayload, reason);
    return versionId;
  }

  /** 参数修订：新参数集，父参数集链接保留。 */
  reviseParameters(params: AnalysisParams, changed: (keyof AnalysisParams)[], reason: string): string {
    const parent = this.currentParameterSetId();
    const parameterSetId = `params_${contentHash({ params, parent })}`;
    if (this.events.some((e) => e.type === 'parameter-revised' && (e.payload as ParameterRevisedPayload).parameterSetId === parameterSetId)) {
      return parameterSetId;
    }
    this.append('parameter-revised', {
      parameterSetId,
      parentParameterSetId: parent,
      params,
      changed,
    } satisfies ParameterRevisedPayload, reason);
    return parameterSetId;
  }

  /** 局部源数据改动：只改指定瓦片内容；未改瓦片保持同一 raw 身份（共享片段只存一份）。 */
  patchSourceTile(parentBundleVersionId: string, tileId: string, mutate: (tile: InputBundle['tiles'][number]) => void, reason: string): string {
    const parentBundle = this.bundleAt(parentBundleVersionId);
    const tile = parentBundle.tiles.find((t) => t.tileId === tileId);
    requireRef(tile, `tile:${tileId}`, this.seqCounter + 1);
    const mutatedTile: InputBundle['tiles'][number] = {
      ...tile!,
      phase: tile!.phase.slice(),
      amplitude: tile!.amplitude.slice(),
      invalid: tile!.invalid.slice(),
      invalidReason: tile!.invalidReason.slice(),
    };
    mutate(mutatedTile);
    const revised: InputBundle = {
      ...parentBundle,
      tiles: parentBundle.tiles.map((t) => (t.tileId === tileId ? mutatedTile : t)),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(revised));
    const rawId = contentId('raw', bytes);
    if (this.store.getRaw(rawId) === null) {
      this.store.putRaw({ rawContentId: rawId, kind: 'bundle', bytes, mediaType: 'application/json', createdAt: this.clock.now() });
    }
    const versionId = `ver_bundle_${contentHash({ rawId, parent: parentBundleVersionId })}`;
    this.append('source-patched', {
      bundleVersionId: versionId,
      parentBundleVersionId,
      rawContentId: rawId,
      changedTileIds: [tileId],
      patchNote: `局部源数据改动，仅瓦片 ${tileId} 改变；其余瓦片身份不变`,
      bundle: revised,
    } satisfies SourcePatchedPayload, reason);
    return versionId;
  }

  // ---------- 派生分析：候选/拒绝/未知都是一等数据 ----------

  produceAnalysis(bundleVersionId: string, parameterSetId: string | null, reason = '运行二维相位展开与高度转换链'): string {
    const params = parameterSetId ? this.paramsAt(parameterSetId) : DEFAULT_PARAMS;
    const pid = parameterSetId ?? 'params-initial';
    const bundle = this.bundleAt(bundleVersionId);
    const grid: RawGrid = assembleBundle(bundle);
    const quality = buildQuality(grid, params, this.seed);
    const unwrap = runUnwrap(grid, quality, { params, seed: this.seed });
    const height = buildHeight(bundle, unwrap, bundle.wavelength.value, bundleVersionId, params);
    const analysisId = `analysis_${contentHash({ bundleVersionId, wavelength: bundleVersionId, parameterSet: pid, unwrap: unwrap.resultId, height: height.heightId })}`;
    if (this.events.some((e) => e.type === 'analysis-produced' && (e.payload as AnalysisProducedPayload).analysisId === analysisId)) {
      return analysisId;
    }
    this.append('analysis-produced', {
      analysisId,
      bundleVersionId,
      wavelengthVersionId: bundleVersionId,
      parameterSetId: pid,
      quality,
      unwrap,
      height,
    } satisfies AnalysisProducedPayload, reason);
    return analysisId;
  }

  adjudicate(analysisId: string, adjudications: CandidateAdjudication[], reason: string): void {
    this.requireAnalysis(analysisId);
    this.append('candidate-adjudicated', { analysisId, adjudications } satisfies import('./events.ts').CandidateAdjudicatedPayload, reason);
  }

  /** 锁定局部解读；同目标已有活动锁定时显式产生冲突事件。 */
  lockLocal(
    analysisId: string,
    target: LocalLockSetPayload['target'],
    lockedValue: LocalLockSetPayload['lockedValue'],
    interpretation: string,
    reason: string,
  ): { lockId: string; conflictId: string | null } {
    this.requireAnalysis(analysisId);
    const lockId = `lock_${contentHash({ analysisId, target, lockedValue, seq: this.seqCounter + 1 })}`;
    this.append('local-lock-set', { analysisId, lockId, target, lockedValue, interpretation } satisfies LocalLockSetPayload, reason);

    const snapshot = this.snapshot();
    const existing = snapshot.locks.find(
      (l) => l.active && l.analysisId === analysisId && l.target.kind === target.kind && l.target.id === target.id && l.lockId !== lockId,
    );
    if (existing) {
      const conflictId = `conflict_${contentHash({ existing: existing.lockId, incoming: lockId })}`;
      const scope = `${target.kind}:${target.id}`;
      const detail = `已有锁定 k=${existing.k ?? 'null'}（${existing.label}）与新锁定 k=${lockedValue.k ?? 'null'}（${lockedValue.label}）冲突`;
      this.append('lock-conflict-detected', {
        conflictId,
        existingLockId: existing.lockId,
        incomingLockId: lockId,
        scope,
        detail,
      } satisfies LockConflictPayload, `检测到局部锁定冲突：${scope}`);
      return { lockId, conflictId };
    }
    return { lockId, conflictId: null };
  }

  resolveLockConflict(conflictId: string, resolution: 'keep-existing' | 'replace', note: string, reason: string): void {
    const snap = this.snapshot();
    const conflict = snap.conflicts.find((c) => c.conflictId === conflictId && c.resolution === 'unresolved');
    requireRef(conflict, `conflict:${conflictId}`, this.seqCounter + 1);
    this.append('lock-conflict-resolved', {
      conflictId,
      existingLockId: conflict!.existingLockId,
      incomingLockId: conflict!.incomingLockId,
      scope: conflict!.scope,
      detail: conflict!.detail,
      resolution: { keptLockId: resolution === 'keep-existing' ? conflict!.existingLockId : conflict!.incomingLockId, resolution, note },
    } satisfies LockConflictPayload, reason);
  }

  /** 撤销一个决定：写 undo 事件，历史不删除。 */
  undoDecision(undoneEventSeq: number, replacementNote: string, reason: string): void {
    const target = this.events.find((e) => e.seq === undoneEventSeq);
    requireRef(target, `event:${undoneEventSeq}`, this.seqCounter + 1);
    this.append('decision-undone', {
      undoneEventSeq,
      undoneEventId: target!.eventId,
      replacementNote,
    } satisfies DecisionUndonePayload, reason);
  }

  /** 回到任意旧事件：恢复当时的依赖版本与可见结论（记录 view-restored，不回写结果）。 */
  restoreView(restoreSeq: number, reason: string): string {
    const target = this.events.find((e) => e.seq === restoreSeq);
    requireRef(target, `event:${restoreSeq}`, this.seqCounter + 1);
    this.restoreSeq = restoreSeq;
    const evt = this.append('view-restored', {
      restoreSeq,
      restoredEventId: target!.eventId,
    } satisfies ViewRestoredPayload, reason);
    return evt.eventId;
  }

  clearViewRestore(): void {
    this.restoreSeq = null;
  }
