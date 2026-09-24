import type {
  CalibrationPlanePayload, ComponentPayload, CutEditHistoryPayload,
  CutNetworkPayload, DomainParams, EdgeRecord, EntityRecord, EventRecord,
  EventType, HeightPayload, IncidenceGeometryPayload, InputKind, LockRecord,
  QualityPayload, ResiduePayload, UnwrapPayload, WavelengthPayload,
} from '../shared/domain';
import {
  ALGO_VERSIONS, DERIVED_KINDS, DEFAULT_PARAMS, KIND_LABEL,
} from '../shared/domain';
import { contentHashOf } from '../core/hash';
import { labelComponents } from '../core/components';
import { buildCutNetwork } from '../core/cuts';
import { computeHeight } from '../core/height';
import { computeQuality } from '../core/quality';
import { computeResidues } from '../core/residues';
import { unwrap } from '../core/unwrap';
import type { Store } from './store';

type Inputs = Partial<Record<InputKind, EntityRecord>>;

export interface Snapshot {
  seq: number;
  statuses: Record<string, EntityRecord['status']>;
  adopted: Record<string, string>;
  locks: Array<{ lockId: string; status: LockRecord['status'] }>;
}

export interface EntityView extends EntityRecord {
  refs: Array<{ entityId: string; version: number; kind: string; summary: string; missing?: boolean }>;
  viewStatus: EntityRecord['status'];
  missingRefs: string[];
}

export interface AsOfView {
  event: EventRecord | null;
  entities: EntityView[];
  locks: LockRecord[];
}

/** 项目编排：不可变输入、增量派生、候选、锁定冲突、历史快照 */
export class Project {
  params: DomainParams = { ...DEFAULT_PARAMS };
  paramsVersion = 1;

  constructor(private store: Store) {}

  // ---- 输入提交：内容寻址、不可覆盖、新版本+父版本 ----
  commitInput(caseKey: string, kind: InputKind, content: unknown, opts: {
    scenario?: string; parentId?: string; parentVersion?: number; actor?: string; rationale?: string;
    emitEvent?: boolean; revision?: boolean; at?: string;
  } = {}): EntityRecord {
    const chash = contentHashOf(content);
    const fragmentId = `frag_${chash}`;
    this.store.putFragment(fragmentId, kind, chash, content);
    const prior = this.store.getInputRef(caseKey, kind, 0)
      ? this.latestInputEntity(caseKey, kind)
      : null;
    const version = prior ? prior.version + 1 : 1;
    const entityId = opts.parentId ?? prior?.entityId ?? `in_${kind}_${chash.slice(0, 10)}`;
    const rec: EntityRecord = {
      entityId, kind, version,
      parentEntityId: prior ? prior.entityId : (opts.parentId ?? null),
      status: 'current',
      algo: null, paramFingerprint: null,
      contentHash: chash, fragmentId, content,
      summary: summarizeInput(kind, content),
      createdAt: opts.at ?? this.storeClockNow(),
      createdByEvent: null,
      scenario: opts.scenario ?? null,
    };
    this.store.insertEntity(rec);
    this.store.setInputRef(caseKey, kind, version, entityId);
    this.store.setInputRef(caseKey, kind, 0, entityId); // current 指针
    if (prior) this.store.setStatus(prior.entityId, prior.version, 'superseded');
    if (opts.emitEvent ?? true) {
      const type: EventType = prior || opts.revision ? 'input_revised' : 'baseline_committed';
      const ev = this.store.appendEvent(type, opts.actor ?? 'reviewer',
        opts.rationale ?? (prior ? `修订输入 ${KIND_LABEL[kind]} v${version}` : `提交基线 ${KIND_LABEL[kind]}`),
        { caseKey, kind, entityId, version, parent: prior ? `${prior.entityId}@${prior.version}` : null,
          contentHash: chash, scenario: opts.scenario ?? null });
      this.store.db.prepare('UPDATE events SET case_key=? WHERE event_id=?').run(caseKey, ev.eventId);
      this.markCreated(rec.entityId, rec.version, ev.eventId);
      rec.createdByEvent = ev.eventId;
    }
    return rec;
  }

  latestInputEntity(caseKey: string, kind: InputKind): EntityRecord | null {
    const rows = (this.store.db.prepare(
      'SELECT entity_id, MAX(version) AS v FROM input_refs WHERE case_key=? AND kind=? AND version>0').get(caseKey, kind)
      ?? {}) as { entity_id?: string; v?: number };
    if (!rows.entity_id || !rows.v) return null;
    return this.store.getEntity(rows.entity_id, rows.v);
  }

  inputsForCase(caseKey: string): Inputs {
    const out: Inputs = {};
    for (const kind of INPUT_KIND_LIST) {
      const r = this.latestInputEntity(caseKey, kind);
      if (r) out[kind] = r;
    }
    return out;
  }

  reviseParams(caseKey: string, patch: Partial<DomainParams>, actor = 'reviewer', rationale = '领域参数修订'): EventRecord {
    this.params = { ...this.params, ...patch };
    this.paramsVersion += 1;
    const ev = this.store.appendEvent('params_revised', actor, rationale,
      { caseKey, params: this.params, paramsVersion: this.paramsVersion });
    this.store.db.prepare('UPDATE events SET case_key=? WHERE event_id=?').run(caseKey, ev.eventId);
    return ev;
  }

  private storeClockNow(): string {
    return (this.store as unknown as { clock: { now(): string } }).clock.now();
  }
  private markCreated(entityId: string, version: number, eventId: string): void {
    this.store.db.prepare('UPDATE entities SET created_by_event=? WHERE entity_id=? AND version=?').run(eventId, entityId, version);
  }

  // ---- 增量派生：局部输入变化只使依赖它的结果过期 ----
  recompute(caseKey: string, actor = 'system', rationale = '增量派生计算'): { created: EntityRecord[] } {
    const inputs = this.inputsForCase(caseKey);
    const need = (k: InputKind): EntityRecord => {
      const r = inputs[k];
      if (!r) throw new Error(`missing-input:${k}`);
      return r;
    };
    const created: EntityRecord[] = [];
    const pfp = (algo: string, parts: unknown[]): string => contentHashOf([algo, this.params, ...parts]);

    const emitComputed = (rec: EntityRecord, inputs2: EntityRecord[], extra?: Record<string, unknown>) => {
      const ev = this.store.appendEvent('computation_completed', actor, rationale, {
        caseKey, entityId: rec.entityId, version: rec.version, kind: rec.kind,
        algo: rec.algo, paramFingerprint: rec.paramFingerprint,
        inputs: inputs2.map((i) => `${i.entityId}@${i.version}`), ...extra,
      });
      this.store.db.prepare('UPDATE events SET case_key=? WHERE event_id=?').run(caseKey, ev.eventId);
      this.markCreated(rec.entityId, rec.version, ev.eventId);
      rec.createdByEvent = ev.eventId;
      this.linkInputs(rec, inputs2);
      created.push(rec);
      this.writeSnapshot(ev);
    };

    const ensureStage = <T extends object>(args: {
      kind: 'quality_map' | 'residue_map' | 'component_map' | 'cut_network';
      algo: string; fpParts: unknown[]; caseKey2: string; content: T;
      deps: EntityRecord[];
    }): EntityRecord => {
      const fp = pfp(args.algo, args.fpParts);
      const found = this.findCurrentByFp(args.caseKey2, args.kind, fp);
      if (found) return found;
      return this.createDerived(args.caseKey2, args.kind, fp, args.algo, args.content, args.deps,
        (rec) => emitComputed(rec, args.deps));
    };

    const has8 = INPUT_KIND_LIST.map((k) => inputs[k]?.contentHash);
    void has8;

    // 质量图：依赖 原相位/振幅/信噪/遮罩
    const wrapped = need('wrapped_phase');
    const amplitude = need('amplitude');
    const snr = need('snr_map');
    const mask = need('invalid_mask');
    const quality = ensureStage({
      caseKey2: caseKey, kind: 'quality_map', algo: ALGO_VERSIONS.quality,
      fpParts: [wrapped.contentHash, amplitude.contentHash, snr.contentHash, mask.contentHash],
      deps: [wrapped, amplitude, snr, mask],
      content: computeQuality(asGrid(wrapped.content), asGrid(amplitude.content), asGrid(snr.content),
        asGrid(mask.content), this.params),
    }) as EntityRecordT<QualityPayload>;

    // 留数/循环残差：依赖 原相位/遮罩
    const residue = ensureStage({
      caseKey2: caseKey, kind: 'residue_map', algo: ALGO_VERSIONS.residues,
      fpParts: [wrapped.contentHash, mask.contentHash], deps: [wrapped, mask],
      content: computeResidues(asGrid(wrapped.content), asGrid(mask.content)),
    }) as EntityRecordT<ResiduePayload>;

    // 多连通区：依赖 原相位/遮罩
    const components = ensureStage({
      caseKey2: caseKey, kind: 'component_map', algo: ALGO_VERSIONS.components,
      fpParts: [wrapped.contentHash, mask.contentHash], deps: [wrapped, mask],
      content: labelComponents(asGrid(wrapped.content), asGrid(mask.content)),
    }) as EntityRecordT<ComponentPayload>;

    // 切口网络：依赖 留数 + 切口编辑历史
    const cutHistory = need('cut_edit_history') as EntityRecordT<CutEditHistoryPayload>;
    const cuts = ensureStage({
      caseKey2: caseKey, kind: 'cut_network', algo: ALGO_VERSIONS.cuts,
      fpParts: [residue.contentHash, cutHistory.contentHash],
      deps: [wrapped, mask, residue, cutHistory],
      content: buildCutNetwork(residue.content, asGrid(wrapped.content).width,
        asGrid(wrapped.content).height, cutHistory.content),
    }) as EntityRecordT<CutNetworkPayload>;

    // 展开候选：两棵展开树 × 整周多解偏移
    const unwrapAlgos: Array<{ strategy: 'bfs' | 'quality'; algo: string }> = [
      { strategy: 'bfs', algo: ALGO_VERSIONS.unwrapBfs },
      { strategy: 'quality', algo: ALGO_VERSIONS.unwrapQuality },
    ];
    let adoptedBfs: EntityRecord | null = null;
    for (const u of unwrapAlgos) {
      const fp = pfp(u.algo, [quality.contentHash, components.contentHash, cuts.contentHash,
        wrapped.contentHash, mask.contentHash, this.params.maxCandidateOffset]);
      const found = this.findCurrentFamily(caseKey, 'unwrap_solution', fp);
      if (found.length) {
        const ad = found.find((f) => f.status === 'current' || f.status === 'locked') ?? found[0]!;
        if (u.strategy === 'bfs') adoptedBfs = ad;
        continue;
      }
      const familyId = `drv_unwrap_${u.strategy}_${fp.slice(0, 12)}`;
      this.supersedeKind(caseKey, 'unwrap_solution', fp);
      const offsetSets = enumerateOffsets(components.content.componentCount, this.params.maxCandidateOffset);
      const deps = [wrapped, mask, quality, components, cuts];
      let first: EntityRecord | null = null;
      offsetSets.forEach((offsets, idx) => {
        const content = unwrap(asGrid(wrapped.content), quality.content, components.content, cuts.content,
          u.strategy, offsets, familyId, idx);
        const rec = this.insertDerivedVersion(caseKey, familyId, 'unwrap_solution', fp, u.algo,
          content, deps, idx === 0 ? 'current' : 'candidate');
        const ev = this.store.appendEvent('candidate_generated', actor,
          '整周多解：保留全部合法候选（路径与循环残差随候选保存）', {
            caseKey, entityId: rec.entityId, version: rec.version, familyId,
            candidateIndex: idx, offsets, strategy: u.strategy,
          });
        this.store.db.prepare('UPDATE events SET case_key=? WHERE event_id=?').run(caseKey, ev.eventId);
        this.markCreated(rec.entityId, rec.version, ev.eventId);
        this.linkInputs(rec, deps);
        created.push(rec);
        if (idx === 0) first = rec;
        this.writeSnapshot(ev);
      });
      if (u.strategy === 'bfs') adoptedBfs = first;
    }

    // 高度转换链：依赖 被采纳的展开解 + 波长 + 入射几何 + 标定面
    const wavelength = need('wavelength') as EntityRecordT<WavelengthPayload>;
    const geometry = need('incidence_geometry') as EntityRecordT<IncidenceGeometryPayload>;
    const calib = need('calibration_plane') as EntityRecordT<CalibrationPlanePayload>;
    const adopted = adoptedBfs ?? this.adoptedUnwrap(caseKey);
    if (adopted) {
      const applyCal = this.store.getMeta(`calibration:${caseKey}`) !== 'off';
      const fp = pfp(ALGO_VERSIONS.height, [adopted.contentHash, wavelength.contentHash,
        geometry.contentHash, calib.contentHash, applyCal]);
      const found = this.findCurrentByFp(caseKey, 'height_map', fp);
      if (!found) {
        this.supersedeKind(caseKey, 'height_map', fp);
        const content = computeHeight(adopted.content as UnwrapPayload, wavelength.content,
          `${wavelength.entityId}@${wavelength.version}`, geometry.content, calib.content, applyCal);
        const deps = [adopted, wavelength, geometry, calib];
        const rec = this.createDerived(caseKey, 'height_map', fp, ALGO_VERSIONS.height, content, deps,
          (r2) => emitComputed(r2, deps, { adoptedUnwrap: `${adopted.entityId}@${adopted.version}` }));
        void rec;
      }
    }
    return { created };
  }

  private linkInputs(rec: EntityRecord, deps: EntityRecord[]): void {
    for (const d of deps) {
      const e: EdgeRecord & { toKind?: string } = {
        fromEntityId: rec.entityId, fromVersion: rec.version,
        toEntityId: d.entityId, toVersion: d.version, toKind: d.kind,
      };
      this.store.insertEdge(e);
    }
  }

  // ---- 派生实体工具 ----
  private createDerived(caseKey: string, kind: 'quality_map' | 'residue_map' | 'component_map' | 'cut_network' | 'height_map',
    fp: string, algo: string, content: object, deps: EntityRecord[],
    after: (rec: EntityRecord) => void): EntityRecord {
    const entityId = `drv_${caseKey}_${kind}`;
    return this.insertDerivedVersion(caseKey, entityId, kind, fp, algo, content, deps, 'current', after);
  }
  private insertDerivedVersion(caseKey: string, entityId: string, kind: EntityRecord['kind'],
    fp: string, algo: string, content: object, deps: EntityRecord[],
    status: EntityRecord['status'], after?: (rec: EntityRecord) => void): EntityRecord {
    const latest = this.store.latestEntity(entityId);
    const rec: EntityRecord = {
      entityId, kind, version: (latest?.version ?? 0) + 1,
      parentEntityId: latest ? entityId : null,
      status, algo, paramFingerprint: fp,
      contentHash: contentHashOf(content),
      content, summary: summarizeDerived(kind, content),
      createdAt: this.storeClockNow(),
      createdByEvent: null,
      scenario: caseKey,
    };
    this.store.insertEntity(rec);
    if (after) after(rec);
    return rec;
  }
  private findCurrentByFp(caseKey: string, kind: EntityRecord['kind'], fp: string): EntityRecord | null {
    const list = this.store.listEntities(kind).filter((e) =>
      e.scenario === caseKey && e.paramFingerprint === fp && ['current', 'locked'].includes(e.status));
    return list[0] ?? null;
  }
  private findCurrentFamily(caseKey: string, kind: EntityRecord['kind'], fp: string): EntityRecord[] {
    return this.store.listEntities(kind).filter((e) =>
      e.scenario === caseKey && e.paramFingerprint === fp
      && ['current', 'candidate', 'locked', 'rejected'].includes(e.status));
  }
  private supersedeKind(caseKey: string, kind: EntityRecord['kind'], exceptFp: string): void {
    for (const e of this.store.listEntities(kind)) {
      if (e.scenario !== caseKey) continue;
      if (e.paramFingerprint === exceptFp) continue;
      if (e.status === 'current' || e.status === 'candidate') {
        this.store.setStatus(e.entityId, e.version, 'stale');
      }
    }
  }
  adoptedUnwrap(caseKey: string): EntityRecord | null {
    const list = this.store.listEntities('unwrap_solution').filter((e) =>
      e.scenario === caseKey && ['current', 'locked'].includes(e.status)
      && (e.content as UnwrapPayload).strategy === 'bfs');
    list.sort((a, b) => b.version - a.version);
    return list[0] ?? null;
  }

  // ---- 候选裁定：采纳/拒绝均保留，原因写入机器可读事件 ----
  adjudicate(caseKey: string, entityId: string, version: number, decision: 'accept' | 'reject',
    actor = 'reviewer', rationale = '人工裁定整周候选', reasonCode = 'manual-review'): EventRecord {
    const target = this.requireEntity(entityId, version);
    const family = (target.content as UnwrapPayload).familyId;
    const siblings = this.store.listEntities('unwrap_solution').filter((e) =>
      e.scenario === caseKey && (e.content as UnwrapPayload).familyId === family);
    if (decision === 'accept') {
      for (const s of siblings) {
        if (s.status === 'locked') continue;
        this.store.setStatus(s.entityId, s.version, s.version === version && s.entityId === entityId ? 'current' : 'rejected');
      }
    } else {
      this.store.setStatus(entityId, version, 'rejected');
    }
    const ev = this.store.appendEvent('candidate_adjudicated', actor, rationale, {
      caseKey, entityId, version, decision, reasonCode, family,
    });
    this.store.db.prepare('UPDATE events SET case_key=? WHERE event_id=?').run(caseKey, ev.eventId);
    this.writeSnapshot(ev);
    this.recomputeHeightAfterDecision(caseKey, family, actor);
    return ev;
  }

  private recomputeHeightAfterDecision(caseKey: string, family: string, actor: string): void {
    const accepted = this.store.listEntities('unwrap_solution').find((e) =>
      e.scenario === caseKey && e.status === 'current' && (e.content as UnwrapPayload).familyId === family);
    if (!accepted) return;
    const inputs = this.inputsForCase(caseKey);
    const wl = inputs.wavelength!; const geo = inputs.incidence_geometry!; const cal = inputs.calibration_plane!;
    const applyCal = this.store.getMeta(`calibration:${caseKey}`) !== 'off';
    const fp = contentHashOf([ALGO_VERSIONS.height, this.params, accepted.contentHash,
      wl.contentHash, geo.contentHash, cal.contentHash, applyCal]);
    if (this.findCurrentByFp(caseKey, 'height_map', fp)) return;
    this.supersedeKind(caseKey, 'height_map', fp);
    const content = computeHeight(accepted.content as UnwrapPayload, wl.content as WavelengthPayload,
      `${wl.entityId}@${wl.version}`, geo.content as IncidenceGeometryPayload,
      cal.content as CalibrationPlanePayload, applyCal);
    const rec = this.insertDerivedVersion(caseKey, `drv_${caseKey}_height_map`, 'height_map',
      fp, ALGO_VERSIONS.height, content, [accepted, wl, geo, cal], 'current');
    const ev = this.store.appendEvent('computation_completed', actor, '采纳候选后重算高度转换链', {
      caseKey, entityId: rec.entityId, version: rec.version, kind: 'height_map',
      algo: rec.algo, paramFingerprint: fp,
      inputs: [accepted, wl, geo, cal].map((i) => `${i.entityId}@${i.version}`),
      adoptedUnwrap: `${accepted.entityId}@${accepted.version}`,
    });
    this.store.db.prepare('UPDATE events SET case_key=? WHERE event_id=?').run(caseKey, ev.eventId);
    this.markCreated(rec.entityId, rec.version, ev.eventId);
    this.linkInputs(rec, [accepted, wl, geo, cal]);
    this.writeSnapshot(ev);
  }

  // ---- 局部锁定与冲突 ----
  lock(caseKey: string, componentId: number, entityId: string, version: number,
    actor = 'reviewer', note = '锁定局部解'): { lock: LockRecord; conflictedWith: string | null } {
    this.requireEntity(entityId, version);
    const existing = this.store.listLocks().filter((l) =>
      l.caseKey === caseKey && l.componentId === componentId
      && ['active', 'conflicted', 'resolved-adopted'].includes(l.status));
    const conflict = existing.find((l) => !(l.solutionEntityId === entityId && l.solutionVersion === version));
    const lockId = `lock_${caseKey}_c${componentId}_${this.store.listLocks().length + 1}`;
    const at = this.storeClockNow();
    const create = (status: LockRecord['status'], evType: EventType, rationale: string, extra: Record<string, unknown> = {}): { lock: LockRecord; conflictedWith: string | null } => {
      const ev = this.store.appendEvent(evType, actor, rationale, {
        caseKey, lockId, componentId, solution: `${entityId}@${version}`, note, ...extra,
      });
      this.store.db.prepare('UPDATE events SET case_key=? WHERE event_id=?').run(caseKey, ev.eventId);
      const lock: LockRecord = {
        lockId, caseKey, componentId, solutionEntityId: entityId, solutionVersion: version,
        status, createdAt: at, createdByEvent: ev.eventId, note,
      };
      this.store.insertLock(lock);
      this.store.setStatus(entityId, version, status === 'reverted' ? this.store.getEntity(entityId, version)!.status : 'locked');
      this.writeSnapshot(ev);
      return { lock, conflictedWith: conflict ? conflict.lockId : null };
    };
    if (conflict) {
      this.store.insertLock({
        lockId: conflict.lockId, caseKey, componentId: conflict.componentId,
        solutionEntityId: conflict.solutionEntityId, solutionVersion: conflict.solutionVersion,
        status: 'conflicted', createdAt: this.store.getEntity(conflict.solutionEntityId, conflict.solutionVersion)?.createdAt ?? at,
        createdByEvent: conflict.createdByEvent, note: conflict.note,
      });
      return create('conflicted', 'lock_conflict',
        '局部锁定冲突：同一连通区存在指向不同候选的有效锁定，两者均保留待裁定',
        { conflictsWith: conflict.lockId, priorSolution: `${conflict.solutionEntityId}@${conflict.solutionVersion}` });
    }
    return create('active', 'solution_locked', '锁定局部解读：该区域回退到精确候选版本，不被最新计算覆盖');
  }

  resolveLock(caseKey: string, lockId: string, decision: 'adopt' | 'reject',
    actor = 'reviewer', rationale = '解决锁定冲突'): EventRecord {
    const locks = this.store.listLocks().filter((l) => l.caseKey === caseKey && l.lockId.startsWith(`lock_${caseKey}_c`));
    const target = locks.find((l) => l.lockId === lockId);
    if (!target) throw new Error(`missing-lock:${lockId}`);
    const componentId = target.componentId;
    const group = locks.filter((l) => l.componentId === componentId && l.status === 'conflicted');
    for (const l of group) {
      const adopt = decision === 'adopt' ? l.lockId === lockId : l.lockId !== lockId;
      this.store.insertLock({ ...l, status: adopt ? 'resolved-adopted' : 'resolved-rejected' });
    }
    const ev = this.store.appendEvent('lock_conflict_resolved', actor, rationale, {
      caseKey, lockId, componentId, decision,
      winning: group.map((l) => ({ lockId: l.lockId, solution: `${l.solutionEntityId}@${l.solutionVersion}`,
        adopted: decision === 'adopt' ? l.lockId === lockId : l.lockId !== lockId })),
    });
    this.store.db.prepare('UPDATE events SET case_key=? WHERE event_id=?').run(caseKey, ev.eventId);
    this.writeSnapshot(ev);
    return ev;
  }

  revertDecision(caseKey: string, lockId: string, actor = 'reviewer', rationale = '撤销人工决定'): EventRecord {
    const lock = this.store.listLocks().find((l) => l.caseKey === caseKey && l.lockId === lockId);
    if (!lock) throw new Error(`missing-lock:${lockId}`);
    this.store.insertLock({ ...lock, status: 'reverted' });
    const ev = this.store.appendEvent('decision_reverted', actor, rationale, {
      caseKey, lockId, componentId: lock.componentId,
      revertedSolution: `${lock.solutionEntityId}@${lock.solutionVersion}`,
    });
    this.store.db.prepare('UPDATE events SET case_key=? WHERE event_id=?').run(caseKey, ev.eventId);
    this.writeSnapshot(ev);
    return ev;
  }

  private requireEntity(entityId: string, version: number): EntityRecord {
    const e = this.store.getEntity(entityId, version);
    if (!e) throw new Error(`missing-reference:${entityId}@${version}`);
    return e;
  }

  setCalibration(caseKey: string, on: boolean): void {
    this.store.setMeta(`calibration:${caseKey}`, on ? 'on' : 'off');
  }

  // ---- 快照与历史重放：回到任意旧事件恢复当时的依赖版本与可见结论 ----
  writeSnapshot(ev: EventRecord): void {
    const statuses: Record<string, EntityRecord['status']> = {};
    const adopted: Record<string, string> = {};
    for (const e of this.store.listEntities()) {
      statuses[`${e.entityId}@${e.version}`] = e.status;
      if (e.kind === 'unwrap_solution' && (e.status === 'current' || e.status === 'locked')) {
        const fam = (e.content as UnwrapPayload).familyId;
        adopted[fam] = `${e.entityId}@${e.version}`;
      }
    }
    const snapshot: Snapshot = {
      seq: ev.seq,
      statuses,
      adopted,
      locks: this.store.listLocks().map((l) => ({ lockId: l.lockId, status: l.status })),
    };
    const payload = { ...ev.payload, snapshot };
    this.store.db.prepare('UPDATE events SET payload=? WHERE event_id=?').run(JSON.stringify(payload), ev.eventId);
    ev.payload = payload;
  }

  /** 重放到 seq：绝不拿最新结果覆盖历史 */
  asOf(caseKey: string, seq: number | 'current'): AsOfView {
    const events = this.store.listEvents().filter((e) => !e.caseKey || e.caseKey === caseKey || caseKey === '*');
    let snapshot: Snapshot | null = null;
    let lastEvent: EventRecord | null = null;
    for (const e of events) {
      if (seq !== 'current' && e.seq > seq) break;
      if (e.payload.snapshot) { snapshot = e.payload.snapshot as Snapshot; lastEvent = e; }
    }
    if (seq === 'current') {
      const statuses: Record<string, EntityRecord['status']> = {};
      const adopted: Record<string, string> = {};
      for (const e of this.store.listEntities()) {
        statuses[`${e.entityId}@${e.version}`] = e.status;
        if (e.kind === 'unwrap_solution' && (e.status === 'current' || e.status === 'locked')) {
          adopted[(e.content as UnwrapPayload).familyId] = `${e.entityId}@${e.version}`;
        }
      }
      snapshot = {
        seq: events.at(-1)?.seq ?? 0, statuses, adopted,
        locks: this.store.listLocks().map((l) => ({ lockId: l.lockId, status: l.status })),
      };
      lastEvent = events.at(-1) ?? null;
    }
    const snap = snapshot ?? { seq: 0, statuses: {}, adopted: {}, locks: [] };
    const views: EntityView[] = [];
    for (const e of this.store.listEntities()) {
      const key = `${e.entityId}@${e.version}`;
      if (!(key in snap.statuses)) continue;
      views.push(this.decorateView({ ...e, viewStatus: snap.statuses[key]! }));
    }
    views.sort((a, b) => a.kind.localeCompare(b.kind) || a.entityId.localeCompare(b.entityId) || a.version - b.version);
    const lockStatus = new Map(snap.locks.map((l) => [l.lockId, l.status]));
    const locks = this.store.listLocks()
      .filter((l) => l.caseKey === caseKey || caseKey === '*')
      .filter((l) => lockStatus.has(l.lockId))
      .map((l) => ({ ...l, status: lockStatus.get(l.lockId)! }));
    return { event: lastEvent, entities: views, locks };
  }

  /** 查询实体：返回引用版本号与内容摘要；缺引用报损坏，不退回最新版 */
  decorateView(rec: EntityRecord): EntityView {
    const refs: EntityView['refs'] = [];
    const missingRefs: string[] = [];
    for (const edge of this.store.edgesOf(rec.entityId, rec.version)) {
      const target = this.store.getEntity(edge.toEntityId, edge.toVersion);
      if (!target) {
        refs.push({ entityId: edge.toEntityId, version: edge.toVersion, kind: edge.toKind ?? '?', summary: '<缺失>', missing: true });
        missingRefs.push(`${edge.toEntityId}@${edge.toVersion}`);
      } else {
        refs.push({ entityId: target.entityId, version: target.version, kind: target.kind, summary: target.summary });
      }
    }
    if (rec.kind === 'height_map' && rec.content && (rec.content as HeightPayload).wavelengthRef) {
      const ref = (rec.content as HeightPayload).wavelengthRef;
      const [id, v] = ref.split('@');
      const target = this.store.getEntity(id!, Number(v));
      if (!target) missingRefs.push(ref);
    }
    return { ...rec, refs, missingRefs, viewStatus: rec.status };
  }

  lineage(entityId: string, version: number): { entity: EntityView; ancestors: EntityView[] } {
    const root = this.decorateView(this.requireEntity(entityId, version));
    const seen = new Set<string>();
    const ancestors: EntityView[] = [];
    const queue = [root];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const r of cur.refs) {
        const key = `${r.entityId}@${r.version}`;
        if (seen.has(key) || r.missing) continue;
        seen.add(key);
        const rec = this.store.getEntity(r.entityId, r.version)!;
        const view = this.decorateView(rec);
        ancestors.push(view);
        queue.push(view);
      }
    }
    return { entity: root, ancestors };
  }

  listEvents(caseKey?: string): EventRecord[] {
    return this.store.listEvents()
      .filter((e) => caseKey ? (!e.caseKey || e.caseKey === caseKey) : true);
  }
}

// ---- 类型与摘要工具 ----
type EntityRecordT<T> = Omit<EntityRecord, 'content'> & { content: T };
function asGrid(content: unknown): import('../shared/domain').Grid {
  const g = (content as { grid?: import('../shared/domain').Grid }).grid;
  if (!g) throw new Error('payload-has-no-grid');
  return g;
}
const INPUT_KIND_LIST: InputKind[] = [
  'wrapped_phase', 'amplitude', 'snr_map', 'invalid_mask',
  'wavelength', 'incidence_geometry', 'calibration_plane', 'cut_edit_history',
];

function enumerateOffsets(componentCount: number, maxOffset: number): Record<number, number>[] {
  if (componentCount <= 1) return [{ 1: 0 }];
  const comps = Array.from({ length: componentCount }, (_, i) => i + 1);
  const free = comps.slice(1);
  const choices = Array.from({ length: 2 * maxOffset + 1 }, (_, i) => i - maxOffset);
  const combos: number[][] = [[]];
  for (let i = 0; i < free.length; i++) {
    const next: number[][] = [];
    for (const c of combos) for (const v of choices) next.push([...c, v]);
    combos.length = 0; combos.push(...next);
  }
  return combos.map((c) => {
    const o: Record<number, number> = { 1: 0 };
    free.forEach((comp, i) => { o[comp] = c[i]!; });
    return o;
  });
}

function summarizeInput(kind: InputKind, content: unknown): string {
  const c = content as Record<string, unknown>;
  if (c.grid) {
    const g = c.grid as { width: number; height: number; unit: string };
    return `${g.width}x${g.height} ${g.unit}`;
  }
  if (kind === 'wavelength') return `${(c as WavelengthPayload).valueNm} nm`;
  if (kind === 'incidence_geometry') return `${(c as IncidenceGeometryPayload).type} ${(c as IncidenceGeometryPayload).incidenceAngleDeg}deg`;
  if (kind === 'calibration_plane') return `plane [${(c as CalibrationPlanePayload).coefficients.join(',')}] nm`;
  if (kind === 'cut_edit_history') return `${(c as CutEditHistoryPayload).edits.length} edits`;
  return kind;
}
function summarizeDerived(kind: EntityRecord['kind'], content: object): string {
  const c = content as Record<string, unknown>;
  if (kind === 'quality_map') return `low-amp ${(c as QualityPayload).lowAmplitudePixels.length}px`;
  if (kind === 'residue_map') return `charged ${(c as ResiduePayload).chargedCount} cycles`;
  if (kind === 'component_map') return `${(c as ComponentPayload).componentCount} components`;
  if (kind === 'cut_network') return `${(c as CutNetworkPayload).cuts.length} cuts`;
  if (kind === 'unwrap_solution') {
    const u = c as unknown as UnwrapPayload;
    return `${u.strategy} cand#${u.candidateIndex} unknown=${u.unknownPixels.length}`;
  }
  if (kind === 'height_map') return `λ=${(c as HeightPayload).wavelengthNm}nm cal=${(c as HeightPayload).calibrationRemoved}`;
  return kind;
}
void DERIVED_KINDS;
