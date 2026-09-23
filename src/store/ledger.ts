import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema.js';
import type {
  DerivedEntity,
  LocalLock,
  RawEntity,
  RecordHeader,
  ReviewEvent,
  SourceRef,
} from '../domain/types.js';
import { CorruptReferenceError } from '../domain/types.js';
import { contentHash, stableId } from '../domain/hash.js';

export interface Clock {
  now(): string;
}

export class VirtualClock implements Clock {
  private t: number;
  constructor(private iso: string = '2026-01-01T00:00:00.000Z') {
    this.t = Date.parse(iso);
  }
  now(): string {
    return new Date(this.t).toISOString();
  }
  advance(ms: number): string {
    this.t += ms;
    return this.now();
  }
  set(iso: string): string {
    this.t = Date.parse(iso);
    return this.now();
  }
}

type AnyRecord = (RawEntity | DerivedEntity | LocalLock) & RecordHeader;

/** 计算实体当前应处于的状态（投影），原始记录行本身的状态字段只反映写入当时。 */
export interface EntityView {
  current: AnyRecord | null;
  allVersions: AnyRecord[];
}

export class LedgerStore {
  readonly db: DatabaseSync;
  seqCounter = 0;

  constructor(db: DatabaseSync, private clock: Clock) {
    this.db = db;
    db.exec(SCHEMA_SQL);
    this.seqCounter = (db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM events').get() as { m: number }).m;
  }

  // --------------------------------------------------------------
  // 写入
  // --------------------------------------------------------------

  /**
   * 写入一条版本记录。所有 sources 必须能在库中找到且内容摘要一致，
   * 否则按损坏处理（绝不静默退回最新版）。
   */
  putVersion(record: AnyRecord): void {
    for (const s of record.sources) this.verifyRef(s);
    const hash = contentHash(stripHeaderForHash(record));
    if (hash !== record.contentHash) {
      throw new CorruptReferenceError(
        { kind: record.kind, entityId: record.entityId, versionId: record.versionId, contentHash: record.contentHash },
        `内容摘要不一致：记录声明 ${record.contentHash}，实际 ${hash}`,
      );
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO entities
         (entity_id, version_id, parent_version_id, kind, status, content_hash,
          algorithm_version, parameter_fingerprint, created_at, superseded_by_version_id, stale_reason, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.entityId,
        record.versionId,
        record.parentVersionId,
        record.kind,
        record.status,
        record.contentHash,
        record.algorithmVersion ?? null,
        record.parameterFingerprint ?? null,
        record.createdAt,
        record.supersededByVersionId ?? null,
        record.staleReason ?? null,
        JSON.stringify(record),
      );
    this.db.prepare('DELETE FROM sources WHERE version_id = ?').run(record.versionId);
    record.sources.forEach((s, i) => {
      this.db
        .prepare(
          `INSERT INTO sources (version_id, ref_kind, ref_entity_id, ref_version_id, ref_content_hash, fragment, ord)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(record.versionId, s.kind, s.entityId, s.versionId, s.contentHash, s.fragment ?? null, i);
    });
    this.db
      .prepare('INSERT OR IGNORE INTO blobs (content_hash, payload, created_at) VALUES (?, ?, ?)')
      .run(record.contentHash, JSON.stringify(stripHeaderForHash(record)), record.createdAt);
  }

  verifyRef(s: SourceRef): void {
    const row = this.db.prepare('SELECT content_hash FROM entities WHERE version_id = ?').get(s.versionId) as
      | { content_hash: string }
      | undefined;
    if (!row) {
      throw new CorruptReferenceError(s, `引用版本 ${s.versionId} 不存在（实体 ${s.entityId}）`);
    }
    if (row.content_hash !== s.contentHash) {
      throw new CorruptReferenceError(
        s,
        `引用摘要不一致：期望 ${s.contentHash}，库中为 ${row.content_hash}`,
      );
    }
  }

  /** 原始输入修订：新版本必须带父版本；父版本标记 superseded 但内容保留。 */
  reviseRaw(newRecord: AnyRecord, parentVersionId: string): void {
    const parent = this.getVersion(parentVersionId);
    if (!parent) throw new Error(`父版本 ${parentVersionId} 不存在，不能作为修订`);
    if (parent.entityId !== newRecord.entityId) {
      throw new Error('修订必须挂在同一实体身份下');
    }
    this.putVersion({ ...newRecord, parentVersionId });
    this.db
      .prepare('UPDATE entities SET status = ?, superseded_by_version_id = ? WHERE version_id = ?')
      .run('superseded', newRecord.versionId, parentVersionId);
  }

  // --------------------------------------------------------------
  // 读取
  // --------------------------------------------------------------

  getVersion(versionId: string): AnyRecord | null {
    const row = this.db.prepare('SELECT payload FROM entities WHERE version_id = ?').get(versionId) as
      | { payload: string }
      | undefined;
    return row ? (JSON.parse(row.payload) as AnyRecord) : null;
  }

  getEntity(entityId: string): EntityView {
    const rows = this.db
      .prepare('SELECT payload FROM entities WHERE entity_id = ? ORDER BY created_at, version_id')
      .all(entityId) as { payload: string }[];
    const allVersions = rows.map((r) => JSON.parse(r.payload) as AnyRecord);
    const current = allVersions.find((v) => v.status === 'current') ?? null;
    return { current, allVersions };
  }

  listByKind(kind: string): AnyRecord[] {
    const rows = this.db.prepare('SELECT payload FROM entities WHERE kind = ?').all(kind) as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as AnyRecord);
  }

  sourcesOf(versionId: string): SourceRef[] {
    const rows = this.db
      .prepare(
        `SELECT ref_kind AS kind, ref_entity_id AS entityId, ref_version_id AS versionId,
                ref_content_hash AS contentHash, fragment
         FROM sources WHERE version_id = ? ORDER BY ord`,
      )
      .all(versionId) as (SourceRef & { fragment: string | null })[];
    return rows.map((r) => ({ ...(r as SourceRef), ...(r.fragment ? { fragment: r.fragment } : {}) }));
  }

  /** 查询任一实体：返回其引用的版本号与内容摘要；缺少引用即抛损坏。 */
  queryWithReferences(versionId: string): { record: AnyRecord; references: SourceRef[] } {
    const record = this.getVersion(versionId);
    if (!record) {
      throw new CorruptReferenceError(
        { kind: 'review_event', entityId: '?', versionId, contentHash: '?' },
        '被查询版本不存在',
      );
    }
    for (const s of record.sources) this.verifyRef(s);
    return { record, references: this.sourcesOf(versionId) };
  }

  // --------------------------------------------------------------
  // 局部失效：沿 sources 依赖边向上传播过期；过期结果仍可查看，不能冒充当前
  // --------------------------------------------------------------

  /** 返回直接或间接依赖 changedVersionId 的所有派生版本（含距离）。 */
  dependentsOf(changedVersionId: string): { versionId: string; distance: number }[] {
    const result = new Map<string, number>();
    const queue: { v: string; d: number }[] = [{ v: changedVersionId, d: 0 }];
    while (queue.length) {
      const { v, d } = queue.shift()!;
      const rows = this.db
        .prepare('SELECT version_id FROM sources WHERE ref_version_id = ?')
        .all(v) as { version_id: string }[];
      for (const r of rows) {
        if (!result.has(r.version_id) || result.get(r.version_id)! > d + 1) {
          result.set(r.version_id, d + 1);
          queue.push({ v: r.version_id, d: d + 1 });
        }
      }
    }
    return [...result.entries()].map(([versionId, distance]) => ({ versionId, distance }));
  }

  /**
   * 标记过期：源版本修订后，依赖旧版本的派生结果标 stale（不删除），
   * 直到以新版本重算产生替身。返回被标过期的版本列表。
   */
  markStale(changedOldVersionId: string, reason: string): string[] {
    const deps = this.dependentsOf(changedOldVersionId);
    const stale: string[] = [];
    for (const { versionId } of deps) {
      const rec = this.getVersion(versionId);
      if (rec && rec.status === 'current') {
        this.db
          .prepare('UPDATE entities SET status = ?, stale_reason = ? WHERE version_id = ?')
          .run('stale', reason, versionId);
        (rec as RecordHeader).status = 'stale';
        rec.staleReason = reason;
        stale.push(versionId);
      }
    }
    return stale;
  }

  /** 重算产生新版本后，把同一实体身份下旧 current 派生版本标 superseded。 */
  supersedeSameEntity(entityId: string, newVersionId: string): void {
    this.db
      .prepare(
        `UPDATE entities SET status = 'superseded', superseded_by_version_id = ?
         WHERE entity_id = ? AND version_id != ? AND status IN ('current','stale')`,
      )
      .run(newVersionId, entityId, newVersionId);
  }

  // --------------------------------------------------------------
  // 事件 / 时间线 / as-of 快照
  // --------------------------------------------------------------

  private snapshotAsOf(entityIds: string[]): ReviewEvent['asOf'] {
    if (entityIds.length === 0) return [];
    const placeholders = entityIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT entity_id, version_id, content_hash FROM entities
         WHERE entity_id IN (${placeholders}) AND status = 'current'`,
      )
      .all(...entityIds) as { entity_id: string; version_id: string; content_hash: string }[];
    return rows.map((r) => ({ entityId: r.entity_id, versionId: r.versionId, contentHash: r.content_hash }));
  }

  appendEvent(
    e: Omit<ReviewEvent, 'seq' | 'eventId' | 'at' | 'asOf'> & { at?: string; asOfEntityIds?: string[] },
  ): ReviewEvent {
    const seq = ++this.seqCounter;
    const at = e.at ?? this.clock.now();
    const eventId = stableId('evt', { seq, type: e.type, at, summary: e.summary, payload: e.payload });
    const asOf = this.snapshotAsOf(e.asOfEntityIds ?? []);
    const full: ReviewEvent = {
      kind: 'review_event',
      seq,
      eventId,
      at,
      type: e.type,
      reviewer: e.reviewer,
      summary: e.summary,
      basis: e.basis,
      affected: e.affected,
      payload: e.payload,
      asOf,
      adopted: e.adopted,
      parentEventId: e.parentEventId,
    };
    this.db
      .prepare(
        `INSERT INTO events (seq, event_id, at, type, reviewer, summary, adopted, parent_event_id, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        seq,
        eventId,
        at,
        full.type,
        full.reviewer,
        full.summary,
        full.adopted ? 1 : 0,
        full.parentEventId,
        JSON.stringify({ basis: full.basis, payload: full.payload }),
      );
    full.affected.forEach((a, i) => {
      this.db
        .prepare('INSERT INTO event_affected (seq, ref_version_id, ord) VALUES (?, ?, ?)')
        .run(seq, a.versionId, i);
    });
    asOf.forEach((s, i) => {
      this.db
        .prepare('INSERT INTO event_asof (seq, entity_id, version_id, content_hash, ord) VALUES (?, ?, ?, ?, ?)')
        .run(seq, s.entityId, s.versionId, s.contentHash, i);
    });
    return full;
  }

  listEvents(): ReviewEvent[] {
    const rows = this.db.prepare('SELECT * FROM events ORDER BY seq').all() as {
      seq: number;
      event_id: string;
      at: string;
      type: ReviewEvent['type'];
      reviewer: string;
      summary: string;
      adopted: number;
      parent_event_id: string | null;
      payload: string;
    }[];
    return rows.map((r) => {
      const inner = JSON.parse(r.payload) as { basis: ReviewEvent['basis']; payload: ReviewEvent['payload'] };
      const affectedRows = this.db
        .prepare(
          `SELECT s.ref_kind AS kind, s.ref_entity_id AS entityId, s.ref_version_id AS versionId,
                  s.ref_content_hash AS contentHash, s.fragment
           FROM event_affected ea JOIN sources s
             ON ea.ref_version_id = s.version_id
           WHERE ea.seq = ? ORDER BY ea.ord`,
        )
        .all(r.seq) as (SourceRef & { fragment: string | null })[];
      const asOfRows = this.db
        .prepare(
          'SELECT entity_id AS entityId, version_id AS versionId, content_hash AS contentHash FROM event_asof WHERE seq = ? ORDER BY ord',
        )
        .all(r.seq) as ReviewEvent['asOf'];
      return {
        kind: 'review_event',
        seq: r.seq,
        eventId: r.event_id,
        at: r.at,
        type: r.type,
        reviewer: r.reviewer,
        summary: r.summary,
        adopted: r.adopted === 1,
        parentEventId: r.parent_event_id,
        basis: inner.basis,
        payload: inner.payload,
        affected: affectedRows.map((a) => ({ ...a, ...(a.fragment ? { fragment: a.fragment } : {}) })),
        asOf: asOfRows,
      };
    });
  }

  /** 回到某事件：返回当时 asOf 版本记录（不覆盖任何历史）。 */
  asOfEvent(seq: number): AnyRecord[] {
    const rows = this.db
      .prepare('SELECT version_id FROM event_asof WHERE seq = ? ORDER BY ord')
      .all(seq) as { version_id: string }[];
    return rows.map((r) => this.getVersion(r.version_id)!).filter(Boolean);
  }

  // --------------------------------------------------------------
  // 局部锁定（含冲突检测）
  // --------------------------------------------------------------

  putLock(lock: LocalLock): void {
    this.putVersion(lock as unknown as AnyRecord);
  }

  listLocks(includeInactive = false): LocalLock[] {
    const all = this.listByKind('local_lock') as unknown as LocalLock[];
    // 每个 lockId 取最新版本
    const latest = new Map<string, LocalLock>();
    for (const l of all) {
      const prev = latest.get(l.lockId);
      const curOrder = (l.payload as { lockSeq?: number } | undefined)?.lockSeq ?? 0;
      const prevOrder = (prev?.payload as { lockSeq?: number } | undefined)?.lockSeq ?? 0;
      if (!prev || curOrder >= prevOrder) latest.set(l.lockId, l);
    }
    return [...latest.values()].filter((l) => includeInactive || l.active);
  }

  // --------------------------------------------------------------
  // 导出 / 导入：身份、顺序、来源关系完整保持；导入前做引用完整性校验
  // --------------------------------------------------------------

  exportBundle(): LedgerExport {
    const entities = (this.db.prepare('SELECT payload FROM entities ORDER BY created_at, version_id').all() as {
      payload: string;
    }[]).map((r) => JSON.parse(r.payload));
    const events = this.listEvents();
    const meta: Record<string, string> = {};
    for (const r of this.db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]) {
      meta[r.key] = r.value;
    }
    return {
      format: 'interferogram-ledger/export',
      formatVersion: 1,
      exportedAt: this.clock.now(),
      meta,
      entities,
      events,
    };
  }

  /** 导入到一个空库；任何引用缺失/摘要不一致都报损坏并整体拒绝。 */
  static importInto(db: DatabaseSync, clock: Clock, bundle: LedgerExport): LedgerStore {
    if (bundle.format !== 'interferogram-ledger/export' || bundle.formatVersion !== 1) {
      throw new Error('导出包格式不被识别');
    }
    const existing = (db.prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number }).n;
    if (existing > 0) throw new Error('导入目标必须是空库（请新建项目或删除本地数据库后再导入）');
    const store = new LedgerStore(db, clock);
    const byVersion = new Map<string, AnyRecord>();
    for (const e of bundle.entities) byVersion.set(e.versionId, e as AnyRecord);

    // 拓扑顺序写入：先无来源的原始输入，再逐层写派生
    const written = new Set<string>();
    let progress = true;
    const pending = new Map(byVersion);
    while (progress && pending.size) {
      progress = false;
      for (const [id, rec] of [...pending.entries()]) {
        if (rec.sources.every((s: SourceRef) => written.has(s.versionId))) {
          store.putVersion(rec);
          written.add(id);
          pending.delete(id);
          progress = true;
        }
      }
    }
    if (pending.size) {
      const first = pending.values().next().value as AnyRecord;
      const missing = first.sources.find((s) => !byVersion.has(s.versionId));
      throw new CorruptReferenceError(
        missing ?? {
          kind: first.kind,
          entityId: first.entityId,
          versionId: first.versionId,
          contentHash: first.contentHash,
        },
        `导出包存在无法闭合的来源引用（${pending.size} 条记录无法落库）`,
      );
    }
    // 事件按 seq 顺序恢复
    for (const ev of bundle.events) {
      db.prepare(
        `INSERT OR REPLACE INTO events (seq, event_id, at, type, reviewer, summary, adopted, parent_event_id, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ev.seq,
        ev.eventId,
        ev.at,
        ev.type,
        ev.reviewer,
        ev.summary,
        ev.adopted ? 1 : 0,
        ev.parentEventId,
        JSON.stringify({ basis: ev.basis, payload: ev.payload }),
      );
      ev.affected.forEach((a, i) => {
        db.prepare('INSERT OR REPLACE INTO event_affected (seq, ref_version_id, ord) VALUES (?, ?, ?)').run(
          ev.seq,
          a.versionId,
          i,
        );
      });
      ev.asOf.forEach((s, i) => {
        db.prepare(
          'INSERT OR REPLACE INTO event_asof (seq, entity_id, version_id, content_hash, ord) VALUES (?, ?, ?, ?, ?)',
        ).run(ev.seq, s.entityId, s.versionId, s.contentHash, i);
      });
    }
    store.seqCounter = bundle.events.reduce((m, e) => Math.max(m, e.seq), 0);
    for (const [k, v] of Object.entries(bundle.meta ?? {})) {
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(k, v);
    }
    return store;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }
  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
}

export interface LedgerExport {
  format: 'interferogram-ledger/export';
  formatVersion: 1;
  exportedAt: string;
  meta: Record<string, string>;
  entities: unknown[];
  events: ReviewEvent[];
}

/** 哈希只覆盖内容字段，不含可变状态头。 */
function stripHeaderForHash(record: unknown): unknown {
  const { status, supersededByVersionId, staleReason, createdAt, ...content } = record as Record<string, unknown>;
  void status;
  void supersededByVersionId;
  void staleReason;
  void createdAt;
  return content;
}


