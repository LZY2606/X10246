import type { LedgerStore } from '../server/store.js';
import type { EventRef } from '../shared/events.js';
import type {
  AnalysisParams,
} from './params.js';
import { ALGO_VERSION, HEIGHT_ALGO_VERSION, DEFAULT_PARAMS, paramFingerprint } from './params.js';
import type {
  CalibrationPlane,
  CounterexampleKind,
  CutEdit,
  HeightChain,
  IntegerCandidate,
  LocalLock,
  RawSourceBundle,
  WavelengthSpec,
} from '../shared/model.js';
import { SeededRng, VirtualClock, contentHash } from './identity.js';
import { buildQuality } from './quality.js';
import { detectResidues } from './residues.js';
import { applyCutHistory, placeCuts } from './cuts.js';
import { unwrap } from './unwrap.js';
import { heightChain } from './height.js';

/**
 * 应用状态机：把不可变原始输入、算法版本/参数指纹、直接来源与人工决定
 * 组织成只追加的事件流。局部输入变化只使依赖它的结果过期；
 * 过期结果仍可查看但不能冒充当前结果。
 */
export interface AnalysisArtifact {
  analysisId: string;
  sourceRef: EventRef;
  algoVersion: string;
  paramFingerprint: string;
  params: AnalysisParams;
  quality: ReturnType<typeof buildQuality>['quality'];
  blocked: boolean[];
  residues: ReturnType<typeof detectResidues>;
  cuts: ReturnType<typeof placeCuts>;
  unwrap: ReturnType<typeof unwrap>;
  height: HeightChain;
  status: 'generated' | 'in-review' | 'accepted' | 'rejected' | 'stale' | 'conflict';
  /** 触发的反例情形，用于归档 */
  counterexamples: CounterexampleKind[];
  diagnostics: string[];
}

export interface ImportOptions {
  operator?: string;
  label?: string;
}

export class LedgerApp {
  constructor(
    private store: LedgerStore,
    private projectId: string,
    private rng: SeededRng,
    private clock: VirtualClock,
  ) {}

  // ---- 不可变原始输入：提交后只追加新版本 ----
  importSource(bundle: RawSourceBundle, opts: ImportOptions = {}): {
    sourceRef: EventRef;
    eventSeq: number;
  } {
    this.store.createProject(this.projectId, this.projectId, this.clock.now());
    const version = this.sourceVersion(bundle.sourceId) + 1;
    const seqBefore = this.store.lastEvent(this.projectId)?.seq ?? 0;
    this.store.putEntity(
      'source',
      bundle.sourceId,
      version,
      `${bundle.label} rows=${bundle.grid.rows}x${bundle.grid.cols}`,
      bundle,
      seqBefore + 1,
    );
    // 波长/几何/标定作为来源内嵌的不可变规格，也各自登记版本，便于波长修订追踪
    this.registerSpecVersions(bundle, seqBefore + 1);
    const ev = this.store.append(this.projectId, {
      eventId: this.rng.id('ev'),
      type: 'source.imported',
      atVirtual: this.clock.now(),
      operator: opts.operator,
      refs: [{ kind: 'source', stableId: bundle.sourceId, version, digest: this.digestOf('source', bundle.sourceId, version) }],
      payload: { sourceId: bundle.sourceId, version, label: opts.label ?? bundle.label, parentSourceId: bundle.parentSourceId },
    });
    this.clock.advance(1);
    return { sourceRef: ev.refs[0], eventSeq: ev.seq };
  }

  private registerSpecVersions(bundle: RawSourceBundle, seq: number): void {
    this.store.putEntity('wavelength', bundle.wavelength.wavelengthId, this.specVersion('wavelength', bundle.wavelength.wavelengthId) + 1,
      `lambda=${bundle.wavelength.value}${bundle.wavelength.unit}`, bundle.wavelength, seq);
    this.store.putEntity('calibration', bundle.calibration.calibrationId, this.specVersion('calibration', bundle.calibration.calibrationId) + 1,
      `scale=${bundle.calibration.pixelScaleMeters} ref=${bundle.calibration.referenceHeightM}`, bundle.calibration, seq);
  }

  private sourceVersion(stableId: string): number {
    // 从实体表查最大版本（events 里无直接版本聚合函数时用 resolve 探测）
    let v = 0;
    for (;;) {
      if (this.store.getEntity(stableId, v + 1)) v++;
      else break;
    }
    return v;
  }
  private specVersion(kind: 'wavelength' | 'calibration', stableId: string): number {
    void kind;
    return this.sourceVersion(stableId);
  }
  private digestOf(kind: EventRef['kind'], stableId: string, version: number): string {
    void kind;
    return this.store.resolve(stableId, version).digest;
  }

  /** 源数据修订：新版本 + 父版本关系；只影响局部依赖时，调用方传入受影响对象 */
  reviseSource(newBundle: RawSourceBundle, affectedAnalysisIds: string[], operator = 'reviewer'): EventRef {
    const version = this.sourceVersion(newBundle.sourceId) + 1;
    this.store.putEntity('source', newBundle.sourceId, version,
      `${newBundle.label} (rev ${version})`, newBundle, (this.store.lastEvent(this.projectId)?.seq ?? 0) + 1);
    this.registerSpecVersions(newBundle, (this.store.lastEvent(this.projectId)?.seq ?? 0) + 1);
    const ref: EventRef = { kind: 'source', stableId: newBundle.sourceId, version, digest: this.digestOf('source', newBundle.sourceId, version) };
    this.store.append(this.projectId, {
      eventId: this.rng.id('ev'), type: 'source.revised', atVirtual: this.clock.now(), operator,
      refs: [ref],
      payload: { sourceId: newBundle.sourceId, version, parentSourceId: newBundle.parentSourceId, affectedAnalysisIds },
    });
    this.clock.advance(1);
    for (const analysisId of affectedAnalysisIds) this.markStale(analysisId, ref, 'source-revised');
    return ref;
  }

  /** 波长版本变更：登记新版本并使依赖旧波长的高度链过期 */
  reviseWavelength(sourceId: string, next: WavelengthSpec, affectedHeightChainIds: string[], operator = 'reviewer'): EventRef {
    const version = this.specVersion('wavelength', next.wavelengthId) + 1;
    this.store.putEntity('wavelength', next.wavelengthId, version,
      `lambda=${next.value}${next.unit} (rev ${version})`, next, (this.store.lastEvent(this.projectId)?.seq ?? 0) + 1);
    const ref: EventRef = { kind: 'wavelength', stableId: next.wavelengthId, version, digest: this.digestOf('wavelength', next.wavelengthId, version) };
    this.store.append(this.projectId, {
      eventId: this.rng.id('ev'), type: 'wavelength.revised', atVirtual: this.clock.now(), operator,
      refs: [ref, this.currentSourceRef(sourceId)],
      payload: { wavelengthId: next.wavelengthId, version, parentId: next.parentId, affectedHeightChainIds },
      counterexample: 'wavelength-version-change',
    });
    this.clock.advance(1);
    for (const chainId of affectedHeightChainIds) this.markStale(chainId, ref, 'wavelength-revised');
    return ref;
  }

  /** 标定面修订 */
  reviseCalibration(sourceId: string, next: CalibrationPlane, affectedHeightChainIds: string[], operator = 'reviewer'): EventRef {
    const version = this.specVersion('calibration', next.calibrationId) + 1;
    this.store.putEntity('calibration', next.calibrationId, version,
      `scale=${next.pixelScaleMeters} (rev ${version})`, next, (this.store.lastEvent(this.projectId)?.seq ?? 0) + 1);
    const ref: EventRef = { kind: 'calibration', stableId: next.calibrationId, version, digest: this.digestOf('calibration', next.calibrationId, version) };
    this.store.append(this.projectId, {
      eventId: this.rng.id('ev'), type: 'calibration.revised', atVirtual: this.clock.now(), operator,
      refs: [ref, this.currentSourceRef(sourceId)],
      payload: { calibrationId: next.calibrationId, version, parentId: next.parentId, affectedHeightChainIds },
    });
    this.clock.advance(1);
    for (const chainId of affectedHeightChainIds) this.markStale(chainId, ref, 'calibration-revised');
    return ref;
  }

  /** 追加一条切口编辑（人工或算法），不可覆盖 */
  appendCutEdit(sourceId: string, edit: CutEdit, operator = 'reviewer'): void {
    const ref = this.currentSourceRef(sourceId);
    this.store.append(this.projectId, {
      eventId: this.rng.id('ev'), type: 'cut.edited', atVirtual: this.clock.now(), operator,
      refs: [ref],
      payload: { editId: edit.editId, parentEditId: edit.parentEditId, action: edit.action, edge: edit.edge, origin: edit.origin, reason: edit.reason },
    });
    this.clock.advance(1);
  }

  private currentSourceRef(sourceId: string): EventRef {
    const version = this.sourceVersion(sourceId);
    if (version === 0) throw new Error(`损坏：源 ${sourceId} 从未导入`);
    return { kind: 'source', stableId: sourceId, version, digest: this.digestOf('source', sourceId, version) };
  }

  /** 运行完整展开链并登记 analysis/tree/candidate/height-chain 实体 */
  analyze(
    bundle: RawSourceBundle,
    params: AnalysisParams = DEFAULT_PARAMS,
    counterexamples: CounterexampleKind[] = [],
    operator = 'algorithm',
  ): AnalysisArtifact {
    const sourceRef = this.currentSourceRef(bundle.sourceId);
    const grid = bundle.grid;
    const { quality, lowAmplitude } = buildQuality(bundle.amplitude, bundle.snr, bundle.invalidMask, params.quality);
    const blocked = bundle.invalidMask.values.map((m, i) => m || lowAmplitude[i]);

    const residues = detectResidues(grid, bundle.wrappedPhase.values, blocked,
      ([r, c]) => this.rng.id(`res_${r}_${c}`));
    const algoCuts = placeCuts(residues, grid.rows, grid.cols,
      (a, b) => this.rng.id(`cut_${a.join('_')}_${b.join('_')}`));
    const cuts = applyCutHistory(algoCuts, bundle.cutHistory);

    const unwrapped = unwrap(grid, bundle.wrappedPhase.values, blocked, cuts, {
      tree: (componentId) => this.rng.id(`tree_${componentId}`),
      edge: (u, v) => this.rng.id(`edge_${u.join('_')}_${v.join('_')}`),
      path: (target) => this.rng.id(`path_${target.join('_')}`),
      cycle: (n) => this.rng.id(`cycle_${n}`),
      candidate: (pixel, reason) => this.rng.id(`cand_${reason}_${pixel.join('_')}`),
    });

    const firstTree = unwrapped.trees[0];
    const height = firstTree
      ? heightChain(this.rng.id('chain'), firstTree, bundle.wavelength, bundle.geometry, bundle.calibration)
      : {
          chainId: this.rng.id('chain'),
          wavelengthId: bundle.wavelength.wavelengthId,
          geometryId: bundle.geometry.geometryId,
          calibrationId: bundle.calibration.calibrationId,
          heightMeters: [],
          diagnostics: [{ index: -1, code: 'NO_VALID_COMPONENT', message: '没有可展开的有效连通分量' }],
        };

    const seq = (this.store.lastEvent(this.projectId)?.seq ?? 0) + 1;
    const fp = paramFingerprint(params);
    const analysisId = this.rng.id('analysis');
    const artifact: AnalysisArtifact = {
      analysisId,
      sourceRef,
      algoVersion: ALGO_VERSION,
      paramFingerprint: fp,
      params,
      quality,
      blocked,
      residues,
      cuts,
      unwrap: unwrapped,
      height,
      status: 'generated',
      counterexamples,
      diagnostics: [],
    };
    const analysisRef = this.store.putEntity('analysis', analysisId, 1,
      `algo=${ALGO_VERSION} residues=${residues.length} cuts=${cuts.length} cand=${unwrapped.candidates.length}`,
      artifact, seq);

    // 树与候选各自登记稳定实体（显示值身份）
    for (const tree of unwrapped.trees) {
      this.store.putEntity('tree', tree.treeId, 1,
        `${tree.componentId} edges=${tree.edges.length} cycles=${tree.cycles.length}`,
        tree, seq);
    }
    for (const cand of unwrapped.candidates) {
      this.store.putEntity('candidate', cand.candidateId, 1,
        `${cand.ambiguityReason} @ ${cand.pixel.join(',')} options=[${cand.kOptions.join(',')}]`,
        cand, seq);
    }
    this.store.putEntity('height-chain', height.chainId, 1,
      `wl=${height.wavelengthId} geo=${height.geometryId}`, height, seq);

    this.store.append(this.projectId, {
      eventId: this.rng.id('ev'), type: 'analysis.generated', atVirtual: this.clock.now(), operator,
      refs: [sourceRef, analysisRef],
      payload: {
        analysisId, algoVersion: ALGO_VERSION, paramFingerprint: fp,
        treeIds: unwrapped.trees.map((t) => t.treeId),
        candidateIds: unwrapped.candidates.map((c) => c.candidateId),
        heightChainId: height.chainId,
        counterexamples,
        residueCount: residues.length,
        cutCount: cuts.length,
      },
      counterexample: counterexamples[0],
      verdict: 'generated',
    });
    this.clock.advance(1);
    return artifact;
  }

  /** 对整周多解候选作出裁定：采纳某个合法 k；拒绝其余（拒绝原因一等保留） */
  decideCandidate(
    candidateId: string,
    acceptedK: number | null,
    rejected: Array<{ k: number; reason: string }> = [],
    operator = 'reviewer',
  ): void {
    const existing = this.store.getEntity(candidateId, 1);
    if (!existing) throw new Error(`损坏：候选 ${candidateId} 不存在`);
    const cand = existing.payload as IntegerCandidate;
    if (acceptedK !== null && !cand.kOptions.includes(acceptedK)) {
      throw new Error(`k=${acceptedK} 不是合法候选 [${cand.kOptions.join(',')}]`);
    }
    const updated: IntegerCandidate = { ...cand, acceptedK };
    const version = this.latestVersion(candidateId) + 1;
    const ref = this.store.putEntity('candidate', candidateId, version,
      `${cand.ambiguityReason} accepted=${acceptedK}`, updated,
      (this.store.lastEvent(this.projectId)?.seq ?? 0) + 1);
    this.store.append(this.projectId, {
      eventId: this.rng.id('ev'),
      type: acceptedK === null ? 'candidate.rejected' : 'candidate.proposed',
      atVirtual: this.clock.now(), operator,
      refs: [ref],
      payload: { candidateId, version, acceptedK, rejected, ambiguityReason: cand.ambiguityReason },
    });
    this.clock.advance(1);
  }

  /** 接受 / 否定一个分析结果（整周候选与表面高度的最终复核） */
  verdict(analysisId: string, decision: 'accepted' | 'rejected', reason: string, operator = 'reviewer'): EventRef {
    const artifact = this.requireArtifact(analysisId);
    const next: AnalysisArtifact = { ...artifact, status: decision };
    const version = this.latestVersion(analysisId) + 1;
    const ref = this.store.putEntity('analysis', analysisId, version,
      `${decision}: ${reason}`, next, (this.store.lastEvent(this.projectId)?.seq ?? 0) + 1);
    this.store.append(this.projectId, {
      eventId: this.rng.id('ev'),
      type: decision === 'accepted' ? 'verdict.accepted' : 'verdict.rejected',
      atVirtual: this.clock.now(), operator,
      refs: [ref, artifact.sourceRef],
      payload: { analysisId, version, decision, reason },
      verdict: decision,
    });
    this.clock.advance(1);
    return ref;
  }

  /** 参数调整：生成新参数指纹，作为新版本决定，不覆盖旧分析 */
  adjustParams(analysisId: string, nextParams: AnalysisParams, reason: string, operator = 'reviewer'): string {
    const artifact = this.requireArtifact(analysisId);
    this.store.append(this.projectId, {
      eventId: this.rng.id('ev'), type: 'params.adjusted', atVirtual: this.clock.now(), operator,
      refs: [this.currentSourceRef(artifact.sourceRef.stableId)],
      payload: { analysisId, oldFingerprint: artifact.paramFingerprint, nextFingerprint: paramFingerprint(nextParams), params: nextParams, reason },
    });
    this.clock.advance(1);
    return paramFingerprint(nextParams);
  }

  /**
   * 锁定局部解读。若同一像素已有不同 lockedK 的锁 -> 冲突，写 local.lock-conflict，
   * 不覆盖旧锁，状态置 conflict。
   */
  lockLocal(analysisId: string, pixel: [number, number], lockedK: number, note?: string, operator = 'reviewer'): LocalLock {
    const artifact = this.requireArtifact(analysisId);
    const lockId = this.rng.id('lock');
    const existingLocks = this.locksByPixel(pixel);
    const conflict = existingLocks.find((l) => l.lockedK !== lockedK);
    const lock: LocalLock = { lockId, pixel, lockedK, ownerEventId: '', note };
    const seq = (this.store.lastEvent(this.projectId)?.seq ?? 0) + 1;
    const lockRef = this.store.putEntity('lock', lockId, 1,
      `lock ${pixel.join(',')} k=${lockedK}`, lock, seq);

    if (conflict) {
      const conflicted: AnalysisArtifact = { ...artifact, status: 'conflict' };
      const v = this.latestVersion(analysisId) + 1;
      const aRef = this.store.putEntity('analysis', analysisId, v, 'conflict: 局部锁定冲突', conflicted, seq);
      this.store.append(this.projectId, {
        eventId: this.rng.id('ev'), type: 'local.lock-conflict', atVirtual: this.clock.now(), operator,
        refs: [lockRef, aRef, { kind: 'lock', stableId: conflict.lockId, version: 1, digest: this.store.resolve(conflict.lockId, 1).digest }],
        payload: { analysisId, pixel, existingK: conflict.lockedK, attemptedK: lockedK, lockId, existingLockId: conflict.lockId },
        verdict: 'conflict', counterexample: 'local-lock-conflict',
      });
      this.clock.advance(1);
      return lock;
    }

    this.store.append(this.projectId, {
      eventId: this.rng.id('ev'), type: 'local.locked', atVirtual: this.clock.now(), operator,
      refs: [lockRef],
      payload: { analysisId, lockId, pixel, lockedK, note },
    });
    this.clock.advance(1);
    return lock;
  }

  /** 撤销：写入一次新的反向事件（不删除历史），冲突解决/撤销都进入历史 */
  undoLock(lockId: string, operator = 'reviewer'): void {
    const res = this.store.resolve(lockId, 1);
    this.store.append(this.projectId, {
      eventId: this.rng.id('ev'), type: 'local.locked', atVirtual: this.clock.now(), operator,
      refs: [{ kind: 'lock', stableId: lockId, version: 1, digest: res.digest }],
      payload: { undo: true, lockId },
    });
    this.clock.advance(1);
  }

  /** 记录一次反例评估结果（机器可读取） */
  recordCounterexample(kind: CounterexampleKind, result: { contained: boolean; affectedIds: string[]; evidence: string }): void {
    this.store.append(this.projectId, {
      eventId: this.rng.id('ev'), type: 'counterexample.evaluated', atVirtual: this.clock.now(), operator: 'system',
      refs: [],
      payload: result, counterexample: kind,
    });
    this.clock.advance(1);
  }

  private latestVersion(stableId: string): number {
    let v = 0;
    while (this.store.getEntity(stableId, v + 1)) v++;
    return v;
  }

  requireArtifact(analysisId: string): AnalysisArtifact {
    const version = this.latestVersion(analysisId);
    if (version === 0) throw new Error(`损坏：分析 ${analysisId} 不存在`);
    const got = this.store.getEntity(analysisId, version);
    return got!.payload as AnalysisArtifact;
  }

  /** 过期：局部输入变化只使依赖它的结果过期；过期结果仍可查看但标记 stale */
  private markStale(stableId: string, becauseRef: EventRef, reason: string): void {
    const version = this.latestVersion(stableId);
    if (version === 0) return;
    const payload = this.store.getEntity(stableId, version)!.payload as AnalysisArtifact | HeightChain;
    const stale = { ...(payload as object), status: 'stale', staleBecause: becauseRef, staleReason: reason };
    const ref = this.store.putEntity(
      stableId.startsWith('chain') ? 'height-chain' : 'analysis',
      stableId, version + 1, `stale: ${reason}`, stale,
      (this.store.lastEvent(this.projectId)?.seq ?? 0) + 1,
    );
    this.store.append(this.projectId, {
      eventId: this.rng.id('ev'), type: 'dependency.staled', atVirtual: this.clock.now(), operator: 'system',
      refs: [ref, becauseRef],
      payload: { stableId, newVersion: version + 1, reason }, verdict: 'stale',
    });
    this.clock.advance(1);
  }

  private locksByPixel(pixel: [number, number]): LocalLock[] {
    // 从事件流收集未撤销的锁
    const events = this.store.events(this.projectId);
    const undone = new Set<string>();
    const locks: LocalLock[] = [];
    for (const ev of events) {
      if (ev.type === 'local.locked' && ev.payload.undo === true) {
        undone.add(String(ev.payload.lockId));
      }
      if (ev.type === 'local.locked' && ev.payload.undo !== true && ev.payload.lockId) {
        const lockId = String(ev.payload.lockId);
        if (!undone.has(lockId)) {
          locks.push({
            lockId,
            pixel: ev.payload.pixel as [number, number],
            lockedK: ev.payload.lockedK as number,
            ownerEventId: ev.eventId,
          });
        }
      }
    }
    return locks.filter((l) => l.pixel[0] === pixel[0] && l.pixel[1] === pixel[1]);
  }

  /** 回到任意旧事件：恢复当时的依赖版本与可见结论（只读投影） */
  replayUntil(seq: number): {
    visible: Array<{ stableId: string; kind: string; version: number; status?: string }>;
    events: number;
  } {
    const events = this.store.events(this.projectId).filter((e) => e.seq <= seq);
    const latest = new Map<string, { kind: string; version: number; status?: string }>();
    for (const ev of events) {
      for (const ref of ev.refs) {
        const prior = latest.get(ref.stableId);
        if (!prior || ref.version >= prior.version) {
          const status = ev.verdict as string | undefined;
          latest.set(ref.stableId, { kind: ref.kind, version: ref.version, status });
        }
      }
    }
    return {
      visible: [...latest.entries()].map(([stableId, v]) => ({ stableId, ...v })),
      events: events.length,
    };
  }

  history() {
    return this.store.events(this.projectId);
  }

  verifyIntegrity() {
    return this.store.verifyChain(this.projectId);
  }

  /** 把一份不可变原始片段以内容寻址方式归档（共享片段只存一份） */
  archiveFragment(kind: string, ownerId: string, content: unknown): string {
    return this.store.putFragment(kind, ownerId, content);
  }

  getFragment(digest: string) {
    return this.store.getFragment(digest);
  }

  exportBytes(): Uint8Array {
    return this.store.exportBytes();
  }

  static initialParams() {
    return DEFAULT_PARAMS;
  }
}

export { ALGO_VERSION, HEIGHT_ALGO_VERSION, contentHash };
