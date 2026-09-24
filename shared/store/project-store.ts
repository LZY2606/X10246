import type { DatabaseSync } from 'node:sqlite';
import { getMeta, setMeta } from './storage.js';
import { contentHash, canonicalJson } from '../domain/hash.js';
import type {
  DecisionRecord,
  DerivedEntity,
  DerivedPayload,
  DomainEvent,
  Entity,
  InputEntity,
  InputKind,
  InputPayload,
  LocalLock,
  SourceRef
} from '../domain/types.js';
import { derivedEntityId, inputEntityId, stableEventId } from './ids.js';
import { CorruptReferenceError, ImmutableViolationError, ConflictError } from './errors.js';
import type { Clock } from '../domain/clock.js';

interface Row { [k: string]: unknown }

export interface CommitInputArgs {
  kind: InputKind;
  payload: InputPayload;
  diagnostics?: string[];
  logicalKey?: string;
  decider?: string;
}

export class ProjectStore {
  private seq = 0;
  constructor(
    readonly db: DatabaseSync,
    readonly projectId: string,
    private clock: Clock
  ) {
    const known = getMeta(db, 'project_id');
    if (!known) setMeta(db, 'project_id', projectId);
    const maxRow = db.prepare('SELECT MAX(seq) AS m FROM events').get() as Row;
    this.seq = Number(maxRow.m ?? 0);
  }

  now(): string {
    return this.clock.nowIso();
  }
  advance(ms: number): void {
    this.clock.advance(ms);
  }

  runTx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------- 事件 ----------
  private recordEvent(type: DomainEvent['type'], payload: unknown, causationId: string | null = null): DomainEvent {
    this.seq += 1;
    const id = stableEventId(type, this.projectId, this.seq);
    const at = this.clock.nowIso();
    this.db
      .prepare(
        `INSERT INTO events(seq,id,type,at,project_id,causation_id,payload_json)
         VALUES(?,?,?,?,?,?,?)`
      )
      .run(this.seq, id, type, at, this.projectId, causationId, canonicalJson(payload));
    return { seq: this.seq, id, type, at, projectId: this.projectId, payload, causationId };
  }

  events(): DomainEvent[] {
    const rows = this.db.prepare('SELECT * FROM events ORDER BY seq ASC').all() as Row[];
    return rows.map((r) => ({
      seq: Number(r.seq),
      id: String(r.id),
      type: String(r.type) as DomainEvent['type'],
      at: String(r.at),
      projectId: String(r.project_id),
      causationId: (r.causation_id as string) ?? null,
      payload: JSON.parse(String(r.payload_json))
    }));
  }

  // ---------- 实体读取 ----------
  private rowToEntity(r: Row): Entity {
    const payload = JSON.parse(String(r.payload_json));
    const base = {
      id: String(r.id),
      version: Number(r.version),
      kind: String(r.kind),
      contentHash: String(r.content_hash),
      committedAt: String(r.committed_at),
      payload
    };
    if (String(r.entity_type) === 'input') {
      return {
        entityType: 'input',
        ...base,
        parentVersionId: (r.parent_version_id as string) ?? null,
        diagnostics: JSON.parse(String(r.diagnostics_json ?? '[]'))
      } as InputEntity;
    }
    return {
      entityType: 'derived',
      ...base,
      algorithmVersion: String(r.algorithm_version),
      parameterFingerprint: String(r.parameter_fingerprint),
      sources: this.sourcesOf(String(r.id), Number(r.version)),
      computedAt: String(r.committed_at),
      stale: Number(r.stale) === 1,
      supersededBy: (r.superseded_by as string) ?? null
    } as DerivedEntity;
  }

  private sourcesOf(id: string, version: number): SourceRef[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sources WHERE owner_id=? AND owner_version=? ORDER BY ref_index ASC`
      )
      .all(id, version) as Row[];
    return rows.map((r) => ({
      entityId: String(r.source_entity_id),
      version: Number(r.source_version),
      contentHash: String(r.source_content_hash),
      role: String(r.role)
    }));
  }

  /** 校验单个实体的全部直接来源；缺引用/版本/摘要不匹配 => 损坏，绝不回退最新版 */
  assertSourcesIntact(entity: DerivedEntity): void {
    for (const ref of entity.sources) {
      const row = this.db
        .prepare('SELECT content_hash FROM entities WHERE id=? AND version=?')
        .get(ref.entityId, ref.version) as Row | undefined;
      if (!row)
        throw new CorruptReferenceError(
          `损坏：${entity.id}@v${entity.version} 引用的 ${ref.entityId}@v${ref.version} 不存在`,
          { entityId: ref.entityId, version: ref.version }
        );
      if (String(row.content_hash) !== ref.contentHash)
        throw new CorruptReferenceError(
          `损坏：${entity.id}@v${entity.version} 的来源 ${ref.entityId}@v${ref.version} 内容摘要不匹配`
        );
    }
  }

  getEntity(id: string, version?: number): Entity {
    const row = version
      ? (this.db.prepare('SELECT * FROM entities WHERE id=? AND version=?').get(id, version) as Row | undefined)
      : (this.db
          .prepare('SELECT * FROM entities WHERE id=? ORDER BY version DESC LIMIT 1')
          .get(id) as Row | undefined);
    if (!row) throw new CorruptReferenceError(`实体不存在：${id}${version ? `@v${version}` : ''}`);
    const entity = this.rowToEntity(row);
    if (entity.entityType === 'derived') this.assertSourcesIntact(entity);
    return entity;
  }

  /** 查询实体时返回它引用的版本号与内容摘要 */
  describeRefs(id: string, version?: number): { entity: Entity; refs: SourceRef[] } {
    const entity = this.getEntity(id, version);
    const refs = entity.entityType === 'derived' ? entity.sources : [];
    return { entity, refs };
  }

  listEntities(kind?: string): Entity[] {
    const rows = (kind
      ? (this.db.prepare('SELECT * FROM entities WHERE kind=? ORDER BY id, version').all(kind) as Row[])
      : (this.db.prepare('SELECT * FROM entities ORDER BY id, version').all() as Row[]));
    return rows.map((r) => this.rowToEntity(r));
  }

  latestVersion(id: string): number {
    const row = this.db.prepare('SELECT MAX(version) AS m FROM entities WHERE id=?').get(id) as Row;
    return Number(row.m ?? 0);
  }

  // ---------- 原始输入提交 / 修订（不可覆盖） ----------
  commitInput(args: CommitInputArgs): { entity: InputEntity; event: DomainEvent; revised: boolean } {
    const id = inputEntityId(args.kind, args.logicalKey);
    const prevVersion = this.latestVersion(id);
    const version = prevVersion + 1;
    const hash = contentHash(args.payload);

    // 同内容重复提交：内容寻址块去重，但实体不覆盖（幂等返回既有版本）
    const dup = this.db
      .prepare('SELECT version FROM entities WHERE id=? AND content_hash=? ORDER BY version DESC LIMIT 1')
      .get(id, hash) as Row | undefined;
    if (dup) {
      return {
        entity: this.getEntity(id, Number(dup.version)) as InputEntity,
        event: this.events().at(-1)!,
        revised: false
      };
    }

    const parentVersionId = prevVersion > 0 ? `${id}@v${prevVersion}` : null;
    const at = this.clock.nowIso();
    const tx = this.db.prepare(
      `INSERT INTO entities(id,version,entity_type,kind,content_hash,parent_version_id,committed_at,payload_json,diagnostics_json)
       VALUES(?,?, 'input', ?,?,?,?,?,?,?)`
    );
    // diagnostics_json 通过 ALTER 兼容：建迁移列
    this.ensureDiagnosticsColumn();
    tx.run(
      id,
      version,
      args.kind,
      hash,
      parentVersionId,
      at,
      canonicalJson(args.payload),
      canonicalJson(args.diagnostics ?? [])
    );
    this.upsertBlob(hash, args.kind, args.payload);

    const type = prevVersion === 0 ? 'input_committed' : 'revision_committed';
    const event = this.recordEvent(type, {
      entityId: id,
      kind: args.kind,
      version,
      parentVersionId,
      contentHash: hash,
      diagnostics: args.diagnostics ?? []
    });

    const entity = this.getEntity(id, version) as InputEntity;
    if (prevVersion > 0) this.markDependentsStale(id, prevVersion);
    return { entity, event, revised: prevVersion > 0 };
  }

  private diagColumnReady = false;
  private ensureDiagnosticsColumn(): void {
    if (this.diagColumnReady) return;
    const cols = this.db.prepare("PRAGMA table_info(entities)").all() as Row[];
    if (!cols.some((c) => String(c.name) === 'diagnostics_json')) {
      this.db.exec('ALTER TABLE entities ADD COLUMN diagnostics_json TEXT');
    }
    this.diagColumnReady = true;
  }

  /** 显式拒绝覆盖：同一 id+version 已存在即报错 */
  overwriteInput(id: string, version: number): never {
    throw new ImmutableViolationError(
      `原始输入不可覆盖：${id}@v${version} 已固化；请提交带父版本关系的新版本`
    );
  }

  private upsertBlob(hash: string, kind: string, payload: unknown): void {
    const json = canonicalJson(payload);
    this.db
      .prepare(
        `INSERT INTO blobs(content_hash,kind,json,byte_length) VALUES(?,?,?,?)
         ON CONFLICT(content_hash) DO NOTHING`
      )
      .run(hash, kind, json, json.length);
  }

  // ---------- 派生计算（带算法版本、参数指纹、直接来源） ----------
  computeDerived(
    kind: DerivedPayload['kind'],
    payload: DerivedPayload,
    sources: SourceRef[],
    causationEventId?: string
  ): { entity: DerivedEntity; event: DomainEvent } {
    // 先校验来源完整
    for (const ref of sources) {
      const row = this.db
        .prepare('SELECT content_hash FROM entities WHERE id=? AND version=?')
        .get(ref.entityId, ref.version) as Row | undefined;
      if (!row)
        throw new CorruptReferenceError(
          `拒绝计算：来源 ${ref.entityId}@v${ref.version} 缺失`,
          { entityId: ref.entityId, version: ref.version }
        );
      if (String(row.content_hash) !== ref.contentHash)
        throw new CorruptReferenceError(`拒绝计算：来源 ${ref.entityId}@v${ref.version} 摘要不匹配`);
    }

    const hash = contentHash(payload);
    // 参数指纹纳入实体身份：不同算法/参数产生不同稳定 id
    const fp =
      'algorithmVersion' in payload
        ? `${(payload as { algorithmVersion: string }).algorithmVersion}|${(payload as { parameterFingerprint: string }).parameterFingerprint}`
        : '';
    const id = derivedEntityId(kind, `${hash}|${fp}`);

    // 同参数+同源+同内容 => 幂等返回既有
    const existing = this.db
      .prepare('SELECT version FROM entities WHERE id=? AND content_hash=? ORDER BY version DESC LIMIT 1')
      .get(id, hash) as Row | undefined;
    if (existing) {
      const entity = this.getEntity(id, Number(existing.version)) as DerivedEntity;
      return { entity, event: this.events().at(-1)! };
    }

    const version = this.latestVersion(id) + 1;
    const at = this.clock.nowIso();
    const algorithmVersion =
      'algorithmVersion' in payload ? (payload as { algorithmVersion: string }).algorithmVersion : 'n/a';
    const parameterFingerprint =
      'parameterFingerprint' in payload ? (payload as { parameterFingerprint: string }).parameterFingerprint : 'n/a';

    this.runTx(() => {
      this.db
        .prepare(
          `INSERT INTO entities(id,version,entity_type,kind,content_hash,committed_at,payload_json,
             algorithm_version,parameter_fingerprint,stale,superseded_by)
           VALUES(?,?,'derived',?,?,?,?,?,?,0,NULL)`
        )
        .run(id, version, kind, hash, at, canonicalJson(payload), algorithmVersion, parameterFingerprint);
      sources.forEach((ref, i) => {
        this.db
          .prepare(
            `INSERT INTO sources(owner_id,owner_version,ref_index,source_entity_id,source_version,source_content_hash,role)
             VALUES(?,?,?,?,?,?,?)`
          )
          .run(id, version, i, ref.entityId, ref.version, ref.contentHash, ref.role);
      });
      this.upsertBlob(hash, kind, payload);
    });

    const event = this.recordEvent(
      'derivation_computed',
      { entityId: id, kind, version, contentHash: hash, sources },
      causationEventId ?? null
    );
    return { entity: this.getEntity(id, version) as DerivedEntity, event };
  }

  /**
   * 局部输入变化 => 只使直接（传递）依赖它的结果过期；
   * 过期结果保留可查看，但标记 stale 且不能充当当前结果。
   */
  private markDependentsStale(sourceEntityId: string, _oldVersion: number): void {
    // 传递闭包：凡来源链中包含该 source 的派生实体
    const allDerived = this.db
      .prepare("SELECT id, version FROM entities WHERE entity_type='derived'")
      .all() as Row[];
    const staleNew: { id: string; version: number; newerId: string }[] = [];
    const dependsOn = (ownerId: string, ownerVersion: number, target: string, seen = new Set<string>()): boolean => {
      const key = `${ownerId}@${ownerVersion}`;
      if (seen.has(key)) return false;
      seen.add(key);
      for (const s of this.sourcesOf(ownerId, ownerVersion)) {
        if (s.entityId === target) return true;
        if (this.isDerived(s.entityId) && dependsOn(s.entityId, s.version, target, seen)) return true;
      }
      return false;
    };
    for (const r of allDerived) {
      const id = String(r.id);
      const version = Number(r.version);
      if (dependsOn(id, version, sourceEntityId)) {
        // 是否已有同 id 更新版本
        const newest = this.latestVersion(id);
        staleNew.push({ id, version, newerId: newest > version ? `${id}@v${newest}` : '' });
      }
    }
    const upd = this.db.prepare('UPDATE entities SET stale=1, superseded_by=? WHERE id=? AND version=?');
    for (const s of staleNew) {
      upd.run(s.newerId || null, s.id, s.version);
      this.recordEvent('derivation_staled', { entityId: s.id, version: s.version, because: sourceEntityId });
    }
  }

  private isDerived(id: string): boolean {
    const row = this.db
      .prepare("SELECT entity_type FROM entities WHERE id=? ORDER BY version DESC LIMIT 1")
      .get(id) as Row | undefined;
    return row?.entity_type === 'derived';
  }

  /** 当前（非过期、每 id 最新）实体 */
  currentEntities(): Entity[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM entities e
         JOIN (SELECT id, MAX(version) mv FROM entities GROUP BY id) g
         ON e.id=g.id AND e.version=g.mv WHERE e.stale=0 ORDER BY e.id`
      )
      .all() as Row[];
    return rows.map((r) => this.rowToEntity(r));
  }

  // ---------- 切口编辑（追加历史） ----------
  appendCutEdit(entry: {
    editor: string;
    action: 'add' | 'remove' | 'confirm' | 'retract';
    edge: { a: [number, number]; b: [number, number] };
    integerOffset?: number | null;
    note?: string;
  }): DomainEvent {
    const payload = {
      editor: entry.editor,
      action: entry.action,
      edge: entry.edge,
      integerOffset: entry.integerOffset ?? null,
      note: entry.note ?? null
    };
    return this.recordEvent('cut_edited', payload);
  }

  cutEditHistory(): DomainEvent['payload'][] {
    return this.events()
      .filter((e) => e.type === 'cut_edited')
      .map((e) => e.payload);
  }

  // ---------- 人工裁定 / 撤销 ----------
  decide(args: {
    targetEntityId: string;
    targetVersion?: number;
    verdict: DecisionRecord['verdict'];
    reason: string;
    decider: string;
    adjustment?: Record<string, number | string>;
  }): { decision: DecisionRecord; event: DomainEvent; conflict: DomainEvent | null } {
    const version = args.targetVersion ?? this.latestVersion(args.targetEntityId);
    this.getEntity(args.targetEntityId, version); // 损坏/缺失即抛错
    const id = `decision:${this.seq + 1}`;
    const at = this.clock.nowIso();

    // 冲突检测：同一目标已有 active 且相反结论
    const prior = this.db
      .prepare(
        'SELECT * FROM decisions WHERE target_entity_id=? AND active=1 ORDER BY decided_at DESC'
      )
      .all(args.targetEntityId) as Row[];
    let conflictsWith: string | null = null;
    let conflictEvent: DomainEvent | null = null;
    const conflicting = prior.find((p) => String(p.verdict) !== args.verdict);
    if (conflicting) conflictsWith = String(conflicting.id);

    const event = this.recordEvent('decision_made', {
      decisionId: id,
      targetEntityId: args.targetEntityId,
      targetVersion: version,
      verdict: args.verdict,
      reason: args.reason,
      adjustment: args.adjustment ?? null,
      conflictsWith
    });
    this.db
      .prepare(
        `INSERT INTO decisions(id,target_entity_id,target_version,verdict,reason,decided_at,decider,adjustment_json,conflicts_with,active,event_seq)
         VALUES(?,?,?,?,?,?,?,?,?,1,?)`
      )
      .run(
        id,
        args.targetEntityId,
        version,
        args.verdict,
        args.reason,
        at,
        args.decider,
        canonicalJson(args.adjustment ?? null),
        conflictsWith,
        event.seq
      );
    if (conflictsWith) {
      conflictEvent = this.recordEvent('conflict_recorded', {
        between: [id, conflictsWith],
        target: `${args.targetEntityId}@v${version}`,
        status: 'unresolved'
      });
    }
    return { decision: this.getDecision(id)!, event, conflict: conflictEvent };
  }

  retractDecision(decisionId: string, retractor: string, reason: string): DomainEvent {
    this.db.prepare('UPDATE decisions SET active=0 WHERE id=?').run(decisionId);
    return this.recordEvent('decision_retracted', { decisionId, retractor, reason });
  }

  resolveConflict(decisionIds: [string, string], winner: string, resolver: string, reason: string): DomainEvent {
    const loser = decisionIds.find((d) => d !== winner)!;
    this.db.prepare('UPDATE decisions SET active=0 WHERE id=?').run(loser);
    return this.recordEvent('conflict_resolved', {
      between: decisionIds,
      winner,
      loser,
      resolver,
      reason
    });
  }

  getDecision(id: string): DecisionRecord | null {
    const r = this.db.prepare('SELECT * FROM decisions WHERE id=?').get(id) as Row | undefined;
    if (!r) return null;
    return {
      id: String(r.id),
      targetEntityId: String(r.target_entity_id),
      targetVersion: Number(r.target_version),
      verdict: String(r.verdict) as DecisionRecord['verdict'],
      reason: String(r.reason),
      decidedAt: String(r.decided_at),
      decider: String(r.decider),
      adjustment: r.adjustment_json ? JSON.parse(String(r.adjustment_json)) : undefined,
      conflictsWith: (r.conflicts_with as string) ?? null
    };
  }
  listDecisions(includeInactive = false): DecisionRecord[] {
    const rows = (includeInactive
      ? (this.db.prepare('SELECT * FROM decisions ORDER BY event_seq').all() as Row[])
      : (this.db.prepare('SELECT * FROM decisions WHERE active=1 ORDER BY event_seq').all() as Row[]));
    return rows.map((r) => this.getDecision(String(r.id))!);
  }

  // ---------- 局部锁定 / 解锁 / 冲突 ----------
  lockLocal(args: {
    scope: LocalLock['scope'];
    treeId: string;
    rootInteger: number;
    lockedEntityId: string;
    lockedVersion?: number;
    locker: string;
  }): { lock: LocalLock; event: DomainEvent; conflictEvent: DomainEvent | null } {
    const version = args.lockedVersion ?? this.latestVersion(args.lockedEntityId);
    this.getEntity(args.lockedEntityId, version);
    const id = `lock:${this.seq + 1}`;
    const at = this.clock.nowIso();

    // 同区域已有 active 但整周基准不同 => 局部锁定冲突（保留双方，记录冲突）
    const scopeKey = canonicalJson(args.scope);
    const others = this.db.prepare('SELECT * FROM locks WHERE active=1').all() as Row[];
    let conflictReason: string | null = null;
    let conflictEvent: DomainEvent | null = null;
    for (const r of others) {
      if (String(r.scope_json) === scopeKey && Number(r.root_integer) !== args.rootInteger) {
        conflictReason = `local_lock_conflict：同区域已有 rootInteger=${r.root_integer}（锁 ${r.id}），新锁请求 ${args.rootInteger}`;
      }
    }

    const event = this.recordEvent('local_locked', {
      lockId: id,
      scope: args.scope,
      treeId: args.treeId,
      rootInteger: args.rootInteger,
      lockedEntityId: args.lockedEntityId,
      lockedVersion: version,
      conflictReason
    });
    this.db
      .prepare(
        `INSERT INTO locks(id,scope_json,tree_id,root_integer,locked_entity_id,locked_version,locked_at,locker,active,conflict_reason,event_seq)
         VALUES(?,?,?,?,?,?,?,?,1,?,?)`
      )
      .run(
        id,
        scopeKey,
        args.treeId,
        args.rootInteger,
        args.lockedEntityId,
        version,
        at,
        args.locker,
        conflictReason,
        event.seq
      );
    if (conflictReason) {
      conflictEvent = this.recordEvent('conflict_recorded', {
        lock: id,
        scope: args.scope,
        status: 'unresolved',
        reason: conflictReason
      });
    }
    return { lock: this.getLock(id)!, event, conflictEvent };
  }

  unlock(lockId: string, unlocker: string): DomainEvent {
    this.db.prepare('UPDATE locks SET active=0 WHERE id=?').run(lockId);
    return this.recordEvent('local_unlocked', { lockId, unlocker });
  }

  getLock(id: string): LocalLock | null {
    const r = this.db.prepare('SELECT * FROM locks WHERE id=?').get(id) as Row | undefined;
    if (!r) return null;
    return {
      id: String(r.id),
      scope: JSON.parse(String(r.scope_json)),
      treeId: String(r.tree_id),
      rootInteger: Number(r.root_integer),
      lockedEntityId: String(r.locked_entity_id),
      lockedVersion: Number(r.locked_version),
      lockedAt: String(r.locked_at),
      locker: String(r.locker),
      active: Number(r.active) === 1,
      conflictReason: (r.conflict_reason as string) ?? null
    };
  }
  listLocks(includeInactive = false): LocalLock[] {
    const rows = (includeInactive
      ? (this.db.prepare('SELECT * FROM locks ORDER BY event_seq').all() as Row[])
      : (this.db.prepare('SELECT * FROM locks WHERE active=1 ORDER BY event_seq').all() as Row[]));
    return rows.map((r) => this.getLock(String(r.id))!);
  }

  // ---------- 机器可读判断事件 ----------
  recordJudgment(args: {
    scenario?: string;
    subject: string;
    rule: string;
    outcome: 'adopted' | 'rejected' | 'unknown' | 'flagged';
    evidence: unknown;
    refs: SourceRef[];
  }): void {
    const id = `judgment:${this.seq + 1}`;
    this.db
      .prepare(
        `INSERT INTO judgments(id,at,scenario,subject,rule,outcome,evidence_json,refs_json,event_seq)
         VALUES(?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        this.clock.nowIso(),
        args.scenario ?? null,
        args.subject,
        args.rule,
        args.outcome,
        canonicalJson(args.evidence),
        canonicalJson(args.refs),
        this.seq
      );
  }
  listJudgments(): Record<string, unknown>[] {
    return (this.db.prepare('SELECT * FROM judgments ORDER BY rowid').all() as Row[]).map((r) => ({
      id: r.id,
      at: r.at,
      scenario: r.scenario,
      subject: r.subject,
      rule: r.rule,
      outcome: r.outcome,
      evidence: JSON.parse(String(r.evidence_json)),
      refs: JSON.parse(String(r.refs_json))
    }));
  }

  // ---------- 时间旅行：回到任意旧事件，恢复当时依赖版本与可见结论 ----------
  /**
   * 重放到指定事件序号得到只读快照。
   * 不修改主库；用内存库回放事件负载中可重建的实体/裁定/锁定。
   * 注意：历史派生实体在主库中永久保留，因此快照通过“当时已存在的实体版本”过滤。
   */
  snapshotAtSeq(targetSeq: number): SnapshotView {
    const eventsUpTo = this.events().filter((e) => e.seq <= targetSeq);
    const knownEntityVersions = new Map<string, number>();
    const staleEntities = new Set<string>();
    const decisionActive = new Map<string, boolean>();
    const lockActive = new Map<string, boolean>();
    const decisionOrder: string[] = [];
    const lockOrder: string[] = [];

    for (const e of eventsUpTo) {
      const p = e.payload as Record<string, unknown>;
      if (e.type === 'input_committed' || e.type === 'revision_committed' || e.type === 'derivation_computed') {
        const id = String(p.entityId);
        knownEntityVersions.set(id, Number(p.version));
      } else if (e.type === 'derivation_staled') {
        staleEntities.add(`${String(p.entityId)}@v${Number(p.version)}`);
      } else if (e.type === 'decision_made') {
        decisionActive.set(String(p.decisionId), true);
        decisionOrder.push(String(p.decisionId));
      } else if (e.type === 'decision_retracted' || e.type === 'conflict_resolved') {
        if (e.type === 'decision_retracted') decisionActive.set(String(p.decisionId), false);
        else {
          const loser = String((p as { loser: string }).loser);
          decisionActive.set(loser, false);
        }
      } else if (e.type === 'local_locked') {
        lockActive.set(String(p.lockId), true);
        lockOrder.push(String(p.lockId));
      } else if (e.type === 'local_unlocked') {
        lockActive.set(String(p.lockId), false);
      }
    }
    return new SnapshotView(this, knownEntityVersions, staleEntities, decisionActive, lockActive, targetSeq);
  }

  /** 可移植导出：实体、内容块、事件、裁定、锁定、判断（顺序/身份/来源全保留） */
  exportPortable(): PortableBundle {
    const entities = (this.db.prepare('SELECT * FROM entities ORDER BY id, version').all() as Row[]).map((r) =>
      this.rowToEntity(r)
    );
    const blobs = (this.db.prepare('SELECT content_hash,kind,json,byte_length FROM blobs ORDER BY content_hash').all() as Row[]).map(
      (r) => ({
        contentHash: String(r.content_hash),
        kind: String(r.kind),
        json: JSON.parse(String(r.json)),
        byteLength: Number(r.byte_length)
      })
    );
    return {
      format: 'fringe-ledger/1',
      projectId: this.projectId,
      exportedAt: this.clock.nowIso(),
      entities,
      blobs,
      events: this.events(),
      decisions: this.listDecisions(true),
      locks: this.listLocks(true),
      judgments: this.listJudgments()
    };
  }

  /** 导入可移植包到空库：身份、顺序、来源关系保持；导入后校验全部引用 */
  importPortable(bundle: PortableBundle): void {
    if (bundle.format !== 'fringe-ledger/1')
      throw new Error(`不支持的导出格式 ${String(bundle.format)}`);
    const count = this.db.prepare('SELECT COUNT(*) c FROM events').get() as Row;
    if (Number(count.c) > 0) throw new Error('importPortable 仅接受空项目数据库');

    this.runTx(() => {
      for (const b of bundle.blobs) {
        this.db
          .prepare('INSERT INTO blobs(content_hash,kind,json,byte_length) VALUES(?,?,?,?) ON CONFLICT DO NOTHING')
          .run(b.contentHash, b.kind, canonicalJson(b.json), b.byteLength);
      }
      for (const e of bundle.entities) {
        if (e.entityType === 'input') {
          this.ensureDiagnosticsColumn();
          this.db
            .prepare(
              `INSERT INTO entities(id,version,entity_type,kind,content_hash,parent_version_id,committed_at,payload_json,diagnostics_json)
               VALUES(?,?, 'input', ?,?,?,?,?,?)`
            )
            .run(
              e.id,
              e.version,
              e.kind,
              e.contentHash,
              e.parentVersionId,
              e.committedAt,
              canonicalJson(e.payload),
              canonicalJson((e as InputEntity).diagnostics ?? [])
            );
          // 完整性：重算内容哈希必须一致
          if (contentHash(e.payload) !== e.contentHash)
            throw new CorruptReferenceError(`导入校验失败：${e.id}@v${e.version} 内容哈希改变`);
        } else {
          const d = e as DerivedEntity;
          this.db
            .prepare(
              `INSERT INTO entities(id,version,entity_type,kind,content_hash,committed_at,payload_json,algorithm_version,parameter_fingerprint,stale,superseded_by)
               VALUES(?,?,'derived',?,?,?,?,?,?,?,?)`
            )
            .run(
              d.id,
              d.version,
              d.kind,
              d.contentHash,
              d.computedAt,
              canonicalJson(d.payload),
              d.algorithmVersion,
              d.parameterFingerprint,
              d.stale ? 1 : 0,
              d.supersededBy
            );
          d.sources.forEach((s, i) => {
            this.db
              .prepare(
                `INSERT INTO sources(owner_id,owner_version,ref_index,source_entity_id,source_version,source_content_hash,role)
                 VALUES(?,?,?,?,?,?,?)`
              )
              .run(d.id, d.version, i, s.entityId, s.version, s.contentHash, s.role);
          });
          if (contentHash(d.payload) !== d.contentHash)
            throw new CorruptReferenceError(`导入校验失败：${d.id}@v${d.version} 内容哈希改变`);
        }
      }
      // 事件按原 seq 回放，保证顺序与 id
      for (const ev of bundle.events) {
        this.db
          .prepare(
            `INSERT INTO events(seq,id,type,at,project_id,causation_id,payload_json) VALUES(?,?,?,?,?,?,?)`
          )
          .run(ev.seq, ev.id, ev.type, ev.at, ev.projectId, ev.causationId, canonicalJson(ev.payload));
      }
      for (const dec of bundle.decisions) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO decisions(id,target_entity_id,target_version,verdict,reason,decided_at,decider,adjustment_json,conflicts_with,active,event_seq)
             VALUES(?,?,?,?,?,?,?,?,?,?,?)`
          )
          .run(
            dec.id,
            dec.targetEntityId,
            dec.targetVersion,
            dec.verdict,
            dec.reason,
            dec.decidedAt,
            dec.decider,
            canonicalJson(dec.adjustment ?? null),
            dec.conflictsWith ?? null,
            1
          );
      }
      for (const lk of bundle.locks) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO locks(id,scope_json,tree_id,root_integer,locked_entity_id,locked_version,locked_at,locker,active,conflict_reason,event_seq)
             VALUES(?,?,?,?,?,?,?,?,1,?,?)`
          )
          .run(
            lk.id,
            canonicalJson(lk.scope),
            lk.treeId,
            lk.rootInteger,
            lk.lockedEntityId,
            lk.lockedVersion,
            lk.lockedAt,
            lk.locker,
            lk.conflictReason,
            null
          );
      }
      for (const j of bundle.judgments) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO judgments(id,at,scenario,subject,rule,outcome,evidence_json,refs_json,event_seq)
             VALUES(?,?,?,?,?,?,?,?,?)`
          )
          .run(
            String(j.id),
            String(j.at),
            (j.scenario as string) ?? null,
            String(j.subject),
            String(j.rule),
            String(j.outcome),
            canonicalJson(j.evidence),
            canonicalJson(j.refs),
            null
          );
      }
      const maxRow = this.db.prepare('SELECT MAX(seq) m FROM events').get() as Row;
      this.seq = Number(maxRow.m ?? 0);
    });

    // 全量引用完整性校验：任何派生缺引用即损坏
    for (const e of this.listEntities()) {
      if (e.entityType === 'derived') this.assertSourcesIntact(e);
    }
  }
}

// ---------- 时间点快照视图 ----------
export class SnapshotView {
  constructor(
    private store: ProjectStore,
    private versions: Map<string, number>,
    private stale: Set<string>,
    private decisionsActive: Map<string, boolean>,
    private locksActive: Map<string, boolean>,
    readonly atSeq: number
  ) {}

  events(): DomainEvent[] {
    return this.store.events().filter((e) => e.seq <= this.atSeq);
  }

  /** 当时“当前可见”的实体版本（旧版本即使未标 stale 也被同 id 更新版取代） */
  visibleEntities(): Entity[] {
    const out: Entity[] = [];
    for (const [id, version] of this.versions) {
      const e = this.store.getEntity(id, version);
      if (!this.stale.has(`${id}@v${version}`)) out.push(e);
    }
    return out;
  }

  getEntityAt(id: string): Entity {
    const v = this.versions.get(id);
    if (!v) throw new CorruptReferenceError(`截至 seq=${this.atSeq}，实体 ${id} 尚不存在`);
    return this.store.getEntity(id, v);
  }

  decisions(): DecisionRecord[] {
    return [...this.decisionsActive.entries()]
      .filter(([, active]) => active)
      .map(([id]) => this.store.getDecision(id)!)
      .filter(Boolean);
  }
  locks(): LocalLock[] {
    return [...this.locksActive.entries()]
      .filter(([, active]) => active)
      .map(([id]) => this.store.getLock(id)!)
      .filter(Boolean);
  }
}

export interface PortableBundle {
  format: 'fringe-ledger/1';
  projectId: string;
  exportedAt: string;
  entities: Entity[];
  blobs: { contentHash: string; kind: string; json: unknown; byteLength: number }[];
  events: DomainEvent[];
  decisions: DecisionRecord[];
  locks: LocalLock[];
  judgments: Record<string, unknown>[];
}
