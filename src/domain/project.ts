// 项目服务：事件溯源状态机。所有可见结论 = 事件日志的折叠；
// 回到任意旧事件 = 折叠到该序号，恢复当时的依赖版本与可见结论。
import { paramFingerprint, VirtualClock } from './core.ts';
import { convertHeight, HEIGHT_ALGO_VERSION } from './height.ts';
import type {
  CutEditHistory,
  DecisionRecord,
  DomainEvent,
  HeightConversion,
  IncidenceGeometry,
  InputEntityBody,
  InvalidMask,
  LocalLock,
  QualityMap,
  ReviewSlice,
  StoredEvent,
  UnwrapCandidate,
  WavelengthSpec,
  WrappedPhaseField,
  CalibrationPlane,
} from './model.ts';
import { FringeStore } from './store.ts';
import { DEFAULT_UNWRAP_PARAMS, runUnwrap, UNWRAP_ALGO_VERSION, type UnwrapParams } from './unwrap.ts';

export interface CandidateView extends UnwrapCandidate {
  currentStatus: 'open' | 'accepted' | 'rejected';
  rejectReason?: string;
  stale: boolean;
}

export interface ProjectState {
  entities: Array<{ entityId: string; kind: string; headVersionId: string; versionCount: number }>;
  candidates: CandidateView[];
  locks: Array<LocalLock & { activeNow: boolean }>;
  decisions: DecisionRecord[];
  heightChains: HeightConversion[];
  events: StoredEvent[];
  review: ReviewSlice;
}

interface FoldState {
  entityVersions: Map<string, string>;
  candidateStatus: Map<string, { status: 'open' | 'accepted' | 'rejected'; reason?: string }>;
  statusHistory: Map<string, Array<{ status: 'open' | 'accepted' | 'rejected'; reason?: string }>>;
  locks: Map<string, { lock: LocalLock; active: boolean }>;
  decisions: DecisionRecord[];
}

export class FringeProject {
  readonly store: FringeStore;

  constructor(path: string, clock = new VirtualClock(), salt = 'fringe-book') {
    this.store = new FringeStore(path, clock, salt);
  }

  static inMemory(clock = new VirtualClock(), salt = 'fringe-book'): FringeProject {
    return new FringeProject(':memory:', clock, salt);
  }

  close(): void {
    this.store.close();
  }

  // ------------------------------------------------------------------ 导入

  /** 初始导入：原相位像素/信噪评分/无效遮罩/波长/入射几何/标定面/切口编辑历史，均不可覆盖。 */
  importInputs(inputs: InputEntityBody[]): Array<{ entityId: string; versionId: string; kind: string }> {
    const out: Array<{ entityId: string; versionId: string; kind: string }> = [];
    for (const body of inputs) {
      const { entityId, versionId } = this.store.commitEntity(body.kind, body);
      this.store.appendEvent({
        type: 'InputCommitted',
        entityId,
        versionId,
        kind: body.kind,
        digest: this.store.headVersion(entityId).digest,
      });
      out.push({ entityId, versionId, kind: body.kind });
    }
    return out;
  }

  /** 修订：新版本 + 父版本；只使依赖它的派生结果过期。 */
  reviseInput(entityId: string, body: InputEntityBody): { versionId: string } {
    const { versionId, parentVersionId } = this.store.reviseEntity(entityId, body);
    this.store.appendEvent({
      type: 'InputRevised',
      entityId,
      versionId,
      parentVersionId,
      kind: body.kind,
    });
    const staleKeys = this.store.markStaleDependents(versionId, entityId);
    for (const key of staleKeys) {
      this.store.appendEvent({ type: 'StalenessMarked', derivedKey: key, becauseOfVersionId: versionId });
    }
    return { versionId };
  }

  entityIdOfKind(kind: InputEntityBody['kind']): string | null {
    const row = this.store.db
      .prepare('SELECT id FROM entities WHERE kind = ? ORDER BY created_at ASC LIMIT 1')
      .get(kind) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private headOf<T extends InputEntityBody>(kind: T['kind']): { body: T; versionId: string } {
    const id = this.entityIdOfKind(kind);
    if (!id) throw new Error(`缺少输入实体: ${kind}`);
    const head = this.store.headVersion(id);
    return { body: this.store.versionContent<T>(head.versionId), versionId: head.versionId };
  }

  // ------------------------------------------------------------------ 展开

  runUnwrap(params: UnwrapParams = DEFAULT_UNWRAP_PARAMS): UnwrapCandidate[] {
    const phase = this.headOf<WrappedPhaseField>('WrappedPhaseField');
    const quality = this.headOf<QualityMap>('QualityMap');
    const mask = this.headOf<InvalidMask>('InvalidMask');
    const cuts = this.headOf<CutEditHistory>('CutEditHistory');
    return this.runUnwrapScoped(
      'main',
      {
        phase: phase.body,
        quality: quality.body,
        mask: mask.body,
        cuts: cuts.body,
      },
      [phase.versionId, quality.versionId, mask.versionId, cuts.versionId],
      params,
    );
  }

  /** 在指定输入集合上展开（反例档案的最小/组合输入走这里），候选 id 以 scope 为前缀保持全局唯一。 */
  runUnwrapScoped(
    scope: string,
    bodies: {
      phase: WrappedPhaseField;
      quality: QualityMap;
      mask: InvalidMask;
      cuts: CutEditHistory;
    },
    sourceVersionIds: string[],
    params: UnwrapParams = DEFAULT_UNWRAP_PARAMS,
  ): UnwrapCandidate[] {
    const output = runUnwrap(
      {
        phase: bodies.phase.phase,
        snr: bodies.quality.snr,
        lowAmplitudeThreshold: bodies.quality.lowAmplitudeThreshold.value,
        invalidMask: bodies.mask.mask,
        cuts: bodies.cuts.cuts,
      },
      params,
    );
    const prefix = (id: string) => `${scope}:${id}`;
    for (const cand of output.candidates) cand.candidateId = prefix(cand.candidateId);
    for (const ev of output.events) {
      if (ev.type === 'CandidateGenerated') ev.candidateId = prefix(ev.candidateId);
      if (ev.type === 'IntegerAmbiguityKept') ev.legalCandidateIds = ev.legalCandidateIds.map(prefix);
    }
    const fp = paramFingerprint({ algo: UNWRAP_ALGO_VERSION, params });
    for (const cand of output.candidates) {
      this.store.putDerived(
        {
          derivedKey: `unwrap:candidate:${cand.candidateId}`,
          algoVersion: UNWRAP_ALGO_VERSION,
          paramFingerprint: fp,
          sourceVersionIds,
        },
        cand,
      );
    }
    for (const ev of output.events) this.store.appendEvent(ev);
    return output.candidates;
  }

  // ------------------------------------------------------------------ 高度链

  convertHeight(candidateId: string): HeightConversion {
    const candRec = this.store.getDerived(`unwrap:candidate:${candidateId}`);
    if (!candRec) throw new Error(`候选不存在: ${candidateId}`);
    const candidate = candRec.content as UnwrapCandidate;
    const wavelength = this.headOf<WavelengthSpec>('WavelengthSpec');
    const geometry = this.headOf<IncidenceGeometry>('IncidenceGeometry');
    const calibration = this.headOf<CalibrationPlane>('CalibrationPlane');
    const { chain, events } = convertHeight({
      candidate,
      wavelength: wavelength.body,
      wavelengthVersionId: wavelength.versionId,
      geometry: geometry.body,
      geometryVersionId: geometry.versionId,
      calibration: calibration.body,
      calibrationVersionId: calibration.versionId,
    });
    this.store.putDerived(
      {
        derivedKey: `height:chain:${chain.chainId}`,
        algoVersion: HEIGHT_ALGO_VERSION,
        paramFingerprint: paramFingerprint({ algo: HEIGHT_ALGO_VERSION }),
        sourceVersionIds: [
          ...candRec.sourceVersionIds,
          wavelength.versionId,
          geometry.versionId,
          calibration.versionId,
        ],
      },
      chain,
    );
    for (const ev of events) this.store.appendEvent(ev);
    return chain;
  }

  // ------------------------------------------------------------------ 决定/锁定/撤销

  decide(candidateId: string, verdict: 'accept' | 'reject' | 'adjust', reason: string): DecisionRecord {
    const decision: DecisionRecord = {
      decisionId: this.store.ids.next('dec'),
      candidateId,
      verdict,
      reason,
    };
    this.store.putDerived(
      {
        derivedKey: `decision:${decision.decisionId}`,
        algoVersion: 'decision/1.0.0',
        paramFingerprint: 'manual',
        sourceVersionIds: [],
      },
      decision,
    );
    this.store.appendEvent({
      type: 'DecisionRecorded',
      decisionId: decision.decisionId,
      candidateId,
      verdict,
      reason,
    });
    return decision;
  }

  /** 局部锁定：与既有活跃锁冲突时保留双方并记 LocalLockConflict。 */
  placeLock(candidateId: string): { lockId: string; conflict: boolean } {
    const candRec = this.store.getDerived(`unwrap:candidate:${candidateId}`);
    if (!candRec) throw new Error(`候选不存在: ${candidateId}`);
    const candidate = candRec.content as UnwrapCandidate;
    const fold = this.fold();
    const lockId = this.store.ids.next('lock');
    const lock: LocalLock = {
      lockId,
      componentId: candidate.componentId,
      candidateId,
      lockedOffsets: candidate.offsets,
      active: true,
    };
    // 冲突检测：同分量已有活跃锁，且整周偏移不一致。
    for (const { lock: other, active } of fold.locks.values()) {
      if (!active || other.componentId !== candidate.componentId) continue;
      const mismatch = other.lockedOffsets.filter(
        (lo) => !candidate.offsets.some((co) => co.cutId === lo.cutId && co.k === lo.k),
      );
      if (mismatch.length > 0 || other.candidateId !== candidateId) {
        this.store.appendEvent({
          type: 'LocalLockConflict',
          lockId: other.lockId,
          incomingCandidateId: candidateId,
          mismatchedCuts: mismatch.map((m) => m.cutId),
          rule: 'local-lock-conflict',
        });
        this.store.putDerived(
          { derivedKey: `lock:${lockId}`, algoVersion: 'lock/1.0.0', paramFingerprint: 'manual', sourceVersionIds: [] },
          lock,
        );
        return { lockId, conflict: true };
      }
    }
    this.store.putDerived(
      { derivedKey: `lock:${lockId}`, algoVersion: 'lock/1.0.0', paramFingerprint: 'manual', sourceVersionIds: [] },
      lock,
    );
    this.store.appendEvent({ type: 'LocalLockPlaced', lockId, candidateId, componentId: candidate.componentId });
    return { lockId, conflict: false };
  }

  resolveLock(lockId: string, resolution: 'keep-lock' | 'adopt-incoming'): void {
    const decisionId = this.store.ids.next('dec');
    this.store.appendEvent({ type: 'LocalLockResolved', lockId, resolution, decisionId });
  }

  /** 撤销：写入历史（UndoApplied 事件），效果由折叠体现。 */
  undo(): StoredEvent | null {
    const events = this.store.events();
    const undoable = new Set(['DecisionRecorded', 'LocalLockPlaced', 'LocalLockResolved']);
    const undone = new Set(events.filter((e) => e.event.type === 'UndoApplied').map((e) => (e.event as any).undoneEventSeq));
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (undoable.has(e.event.type) && !undone.has(e.seq)) {
        return this.store.appendEvent({
          type: 'UndoApplied',
          undoneEventSeq: e.seq,
          decisionId: this.store.ids.next('dec'),
        });
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ 折叠 / 复核

  fold(upToSeq?: number): FoldState {
    const state: FoldState = {
      entityVersions: new Map(),
      candidateStatus: new Map(),
      statusHistory: new Map(),
      locks: new Map(),
      decisions: [],
    };
    const events = this.store.events().filter((e) => upToSeq === undefined || e.seq <= upToSeq);
    const bySeq = new Map(events.map((e) => [e.seq, e]));
    for (const { event } of events) {
      switch (event.type) {
        case 'InputCommitted':
        case 'InputRevised':
          state.entityVersions.set(event.entityId, event.versionId);
          break;
        case 'DecisionRecorded': {
          const prev = state.candidateStatus.get(event.candidateId) ?? { status: 'open' as const };
          const hist = state.statusHistory.get(event.candidateId) ?? [];
          hist.push(prev);
          state.statusHistory.set(event.candidateId, hist);
          state.candidateStatus.set(event.candidateId, {
            status: event.verdict === 'accept' ? 'accepted' : event.verdict === 'reject' ? 'rejected' : 'open',
            reason: event.reason,
          });
          break;
        }
        case 'LocalLockPlaced': {
          const rec = this.store.getDerived(`lock:${event.lockId}`);
          if (rec) state.locks.set(event.lockId, { lock: rec.content as LocalLock, active: true });
          break;
        }
        case 'LocalLockResolved': {
          const cur = state.locks.get(event.lockId);
          if (cur && event.resolution === 'adopt-incoming') cur.active = false;
          break;
        }
        case 'UndoApplied': {
          const target = bySeq.get(event.undoneEventSeq);
          if (!target) break;
          if (target.event.type === 'DecisionRecorded') {
            const cid = target.event.candidateId;
            const hist = state.statusHistory.get(cid) ?? [];
            const prev = hist.pop() ?? { status: 'open' as const };
            state.candidateStatus.set(cid, prev);
          } else if (target.event.type === 'LocalLockPlaced') {
            const cur = state.locks.get(target.event.lockId);
            if (cur) cur.active = false;
          } else if (target.event.type === 'LocalLockResolved') {
            const cur = state.locks.get(target.event.lockId);
            if (cur) cur.active = true;
          }
          break;
        }
      }
    }
    for (const d of this.store.allDerived()) {
      if (d.derivedKey.startsWith('decision:')) {
        state.decisions.push(this.store.getBlob<DecisionRecord>(d.contentHash));
      }
    }
    return state;
  }

  /** 复核切片：任一事件序号处的可见结论 + 当时的依赖版本。 */
  reviewAt(upToSeq?: number): ReviewSlice {
    const fold = this.fold(upToSeq);
    const versionOf = (kind: InputEntityBody['kind']): string => {
      const id = this.entityIdOfKind(kind);
      if (!id) return '';
      const asOf = fold.entityVersions.get(id);
      return asOf ?? this.store.headVersion(id).versionId;
    };
    const accepted = [...fold.candidateStatus.entries()].find(([, s]) => s.status === 'accepted');
    const anyCandidate = this.store.allDerived().find((d) => d.derivedKey.startsWith('unwrap:candidate:'));
    const candidateId = accepted?.[0] ?? (anyCandidate ? anyCandidate.derivedKey.split(':').pop()! : null);
    let residuals: ReviewSlice['cycleResiduals'] = [];
    if (candidateId) {
      const rec = this.store.getDerived(`unwrap:candidate:${candidateId}`);
      if (rec) residuals = (rec.content as UnwrapCandidate).cycleResiduals;
    }
    const chains = this.store
      .allDerived()
      .filter((d) => d.derivedKey.startsWith('height:chain:'))
      .map((d) => this.store.getBlob<HeightConversion>(d.contentHash));
    return {
      wrappedPhaseRef: versionOf('WrappedPhaseField'),
      unwrappedCandidateId: candidateId,
      qualityMapRef: versionOf('QualityMap'),
      cutNetworkRef: versionOf('CutEditHistory'),
      cycleResiduals: residuals,
      heightChainId: chains.length > 0 ? chains[chains.length - 1].chainId : null,
      locks: [...fold.locks.values()].filter((l) => l.active).map((l) => l.lock),
    };
  }

  state(): ProjectState {
    const fold = this.fold();
    const entities = (this.store.db.prepare('SELECT * FROM entities ORDER BY created_at, id').all() as any[]).map(
      (e) => ({
        entityId: e.id as string,
        kind: e.kind as string,
        headVersionId: this.store.headVersion(e.id).versionId,
        versionCount: (this.store.db.prepare('SELECT COUNT(*) n FROM versions WHERE entity_id = ?').get(e.id) as any)
          .n as number,
      }),
    );
    const staleKeys = new Set(this.store.allDerived().filter((d) => d.status === 'stale').map((d) => d.derivedKey));
    const candidates: CandidateView[] = this.store
      .allDerived()
      .filter((d) => d.derivedKey.startsWith('unwrap:candidate:'))
      .map((d) => {
        const cand = this.store.getBlob<UnwrapCandidate>(d.contentHash);
        const folded = fold.candidateStatus.get(cand.candidateId);
        return {
          ...cand,
          currentStatus: folded?.status ?? 'open',
          rejectReason: folded?.reason,
          stale: staleKeys.has(d.derivedKey),
        };
      });
    const heightChains = this.store
      .allDerived()
      .filter((d) => d.derivedKey.startsWith('height:chain:'))
      .map((d) => this.store.getBlob<HeightConversion>(d.contentHash));
    return {
      entities,
      candidates,
      locks: [...fold.locks.values()].map((l) => ({ ...l.lock, activeNow: l.active })),
      decisions: fold.decisions,
      heightChains,
      events: this.store.events(),
      review: this.reviewAt(),
    };
  }

  /** 查询任一实体：返回引用的版本号与内容摘要；缺少引用报损坏。 */
  entityReport(entityId: string) {
    const view = this.store.entityView(entityId);
    return {
      entityId: view.entityId,
      kind: view.kind,
      headVersionId: view.headVersionId,
      versions: view.versions.map((v) => ({
        versionId: v.versionId,
        versionNo: v.versionNo,
        parentVersionId: v.parentVersionId,
        digest: v.digest,
      })),
    };
  }
}
