// 持久化：SQLite（node:sqlite）。不可变内容库 + 版本链 + 事件日志 + 派生缓存。
import { DatabaseSync } from 'node:sqlite';
import {
  contentHash,
  IdFactory,
  stableStringify,
  VirtualClock,
  type EntityId,
  type EventId,
  type VersionId,
} from './core.ts';
import type { DomainEvent, StoredEvent } from './model.ts';

export class CorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptionError';
  }
}

export interface VersionRecord {
  versionId: VersionId;
  entityId: EntityId;
  versionNo: number;
  parentVersionId: VersionId | null;
  contentHash: string;
  digest: string;
  createdAt: number;
}

export interface EntityView {
  entityId: EntityId;
  kind: string;
  headVersionId: VersionId;
  versions: VersionRecord[];
}

export interface DerivedRecord {
  derivedKey: string;
  algoVersion: string;
  paramFingerprint: string;
  sourceVersionIds: VersionId[];
  contentHash: string;
  status: 'current' | 'stale';
}

export class FringeStore {
  readonly db: DatabaseSync;
  readonly ids: IdFactory;
  readonly clock: VirtualClock;

  constructor(path: string, clock: VirtualClock = new VirtualClock(), salt = 'fringe-book') {
    this.clock = clock;
    this.db = new DatabaseSync(path);
    this.ids = new IdFactory(salt, clock);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blobs (
        hash TEXT PRIMARY KEY,
        content TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        version_id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL REFERENCES entities(id),
        version_no INTEGER NOT NULL,
        parent_version_id TEXT,
        content_hash TEXT NOT NULL REFERENCES blobs(hash),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS derived (
        derived_key TEXT PRIMARY KEY,
        algo_version TEXT NOT NULL,
        param_fingerprint TEXT NOT NULL,
        source_version_ids TEXT NOT NULL,
        content_hash TEXT NOT NULL REFERENCES blobs(hash),
        status TEXT NOT NULL CHECK (status IN ('current','stale'))
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** 不可变内容库：同一内容只存一份（共享原始片段只存一份）。 */
  putBlob(content: unknown): string {
    const hash = contentHash(content);
    const text = typeof content === 'string' ? content : stableStringify(content);
    this.db.prepare('INSERT OR IGNORE INTO blobs (hash, content) VALUES (?, ?)').run(hash, text);
    return hash;
  }

  getBlob<T>(hash: string): T {
    const row = this.db.prepare('SELECT content FROM blobs WHERE hash = ?').get(hash) as
      | { content: string }
      | undefined;
    if (!row) {
      // 缺少引用必须报损坏，不能退回当前最新版。
      throw new CorruptionError(`缺少内容引用 ${hash}，档案损坏`);
    }
    return JSON.parse(row.content) as T;
  }

  commitEntity(kind: string, content: unknown, entityId?: EntityId): { entityId: EntityId; versionId: VersionId } {
    const id = entityId ?? this.ids.next('ent');
    const hash = this.putBlob(content);
    const versionId = this.ids.next('ver');
    this.db.prepare('INSERT INTO entities (id, kind, created_at) VALUES (?, ?, ?)').run(
      id,
      kind,
      this.clock.tick(),
    );
    this.db.prepare(
      'INSERT INTO versions (version_id, entity_id, version_no, parent_version_id, content_hash, created_at) VALUES (?, ?, 1, NULL, ?, ?)',
    ).run(versionId, id, hash, this.clock.current());
    return { entityId: id, versionId };
  }

  /** 修订：新版本 + 父版本关系；旧版本保持不可变。 */
  reviseEntity(entityId: EntityId, content: unknown): { versionId: VersionId; parentVersionId: VersionId } {
    const head = this.headVersion(entityId);
    const hash = this.putBlob(content);
    const versionId = this.ids.next('ver');
    this.db.prepare(
      'INSERT INTO versions (version_id, entity_id, version_no, parent_version_id, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(versionId, entityId, head.versionNo + 1, head.versionId, hash, this.clock.tick());
    return { versionId, parentVersionId: head.versionId };
  }

  headVersion(entityId: EntityId): VersionRecord {
    const row = this.db
      .prepare('SELECT * FROM versions WHERE entity_id = ? ORDER BY version_no DESC LIMIT 1')
      .get(entityId) as any;
    if (!row) throw new CorruptionError(`实体 ${entityId} 不存在`);
    return this.toVersionRecord(row);
  }

  entityView(entityId: EntityId): EntityView {
    const ent = this.db.prepare('SELECT * FROM entities WHERE id = ?').get(entityId) as any;
    if (!ent) throw new CorruptionError(`实体 ${entityId} 不存在`);
    const rows = this.db
      .prepare('SELECT * FROM versions WHERE entity_id = ? ORDER BY version_no ASC')
      .all(entityId) as any[];
    const versions = rows.map((r) => this.toVersionRecord(r));
    // 查询任一实体时校验其引用的内容存在；缺失即损坏。
    for (const v of versions) this.getBlob(v.contentHash);
    return { entityId, kind: ent.kind, headVersionId: versions[versions.length - 1].versionId, versions };
  }

  versionContent<T>(versionId: VersionId): T {
    const row = this.db.prepare('SELECT content_hash FROM versions WHERE version_id = ?').get(versionId) as
      | { content_hash: string }
      | undefined;
    if (!row) throw new CorruptionError(`版本 ${versionId} 不存在`);
    return this.getBlob<T>(row.content_hash);
  }

  private toVersionRecord(row: any): VersionRecord {
    return {
      versionId: row.version_id,
      entityId: row.entity_id,
      versionNo: row.version_no,
      parentVersionId: row.parent_version_id,
      contentHash: row.content_hash,
      digest: row.content_hash.slice(0, 20),
      createdAt: row.created_at,
    };
  }

  // ------------------------------------------------------------------ events

  appendEvent(event: DomainEvent): StoredEvent {
    const eventId: EventId = this.ids.next('evt');
    const at = this.clock.tick();
    this.db.prepare('INSERT INTO events (event_id, at, payload) VALUES (?, ?, ?)').run(
      eventId,
      at,
      stableStringify(event),
    );
    const seq = (this.db.prepare('SELECT last_insert_rowid() AS seq').get() as any).seq as number;
    return { seq, eventId, at, event };
  }

  events(): StoredEvent[] {
    const rows = this.db.prepare('SELECT seq, event_id, at, payload FROM events ORDER BY seq ASC').all() as any[];
    return rows.map((r) => ({ seq: r.seq, eventId: r.event_id, at: r.at, event: JSON.parse(r.payload) }));
  }

  // ----------------------------------------------------------------- derived

  putDerived(rec: Omit<DerivedRecord, 'contentHash'>, content: unknown): DerivedRecord {
    const hash = this.putBlob(content);
    this.db
      .prepare(
        `INSERT INTO derived (derived_key, algo_version, param_fingerprint, source_version_ids, content_hash, status)
         VALUES (?, ?, ?, ?, ?, 'current')
         ON CONFLICT(derived_key) DO UPDATE SET
           algo_version=excluded.algo_version, param_fingerprint=excluded.param_fingerprint,
           source_version_ids=excluded.source_version_ids, content_hash=excluded.content_hash, status='current'`,
      )
      .run(rec.derivedKey, rec.algoVersion, rec.paramFingerprint, JSON.stringify(rec.sourceVersionIds), hash);
    return { ...rec, contentHash: hash, status: 'current' };
  }

  getDerived(key: string): (DerivedRecord & { content: unknown }) | null {
    const row = this.db.prepare('SELECT * FROM derived WHERE derived_key = ?').get(key) as any;
    if (!row) return null;
    return {
      derivedKey: row.derived_key,
      algoVersion: row.algo_version,
      paramFingerprint: row.param_fingerprint,
      sourceVersionIds: JSON.parse(row.source_version_ids),
      contentHash: row.content_hash,
      status: row.status,
      content: this.getBlob(row.content_hash),
    };
  }

  allDerived(): DerivedRecord[] {
    const rows = this.db.prepare('SELECT * FROM derived ORDER BY derived_key').all() as any[];
    return rows.map((row) => ({
      derivedKey: row.derived_key,
      algoVersion: row.algo_version,
      paramFingerprint: row.param_fingerprint,
      sourceVersionIds: JSON.parse(row.source_version_ids),
      contentHash: row.content_hash,
      status: row.status,
    }));
  }

  /** 局部输入变化只使依赖它的结果过期；过期结果仍可查看但标记 stale。 */
  markStaleDependents(newVersionId: VersionId, entityId: EntityId): string[] {
    const affected: string[] = [];
    for (const d of this.allDerived()) {
      if (d.status === 'stale') continue;
      const dependsOnEntity = d.sourceVersionIds.some((vid) => {
        const row = this.db.prepare('SELECT entity_id FROM versions WHERE version_id = ?').get(vid) as any;
        return row && row.entity_id === entityId;
      });
      if (dependsOnEntity) {
        this.db.prepare("UPDATE derived SET status = 'stale' WHERE derived_key = ?").run(d.derivedKey);
        affected.push(d.derivedKey);
      }
    }
    return affected;
  }

  // ------------------------------------------------------------------ 导出/导入

  /** 导出完整档案（身份、顺序、来源关系全部保留）。 */
  exportArchive(): string {
    const dump = {
      format: 'fringe-book-archive/v1',
      blobs: this.db.prepare('SELECT * FROM blobs ORDER BY hash').all(),
      entities: this.db.prepare('SELECT * FROM entities ORDER BY created_at, id').all(),
      versions: this.db.prepare('SELECT * FROM versions ORDER BY entity_id, version_no').all(),
      events: this.db.prepare('SELECT * FROM events ORDER BY seq').all(),
      derived: this.db.prepare('SELECT * FROM derived ORDER BY derived_key').all(),
    };
    return JSON.stringify(dump, null, 2);
  }

  /** 导入到空库：逐行恢复，保持身份与顺序。 */
  static importArchive(path: string, archiveJson: string, clock = new VirtualClock()): FringeStore {
    const dump = JSON.parse(archiveJson);
    if (dump.format !== 'fringe-book-archive/v1') throw new Error('未知档案格式');
    const store = new FringeStore(path, clock);
    const insertBlob = store.db.prepare('INSERT OR IGNORE INTO blobs (hash, content) VALUES (?, ?)');
    const insertEntity = store.db.prepare('INSERT INTO entities (id, kind, created_at) VALUES (?, ?, ?)');
    const insertVersion = store.db.prepare(
      'INSERT INTO versions (version_id, entity_id, version_no, parent_version_id, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insertEvent = store.db.prepare('INSERT INTO events (seq, event_id, at, payload) VALUES (?, ?, ?, ?)');
    const insertDerived = store.db.prepare(
      'INSERT INTO derived (derived_key, algo_version, param_fingerprint, source_version_ids, content_hash, status) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const b of dump.blobs as any[]) insertBlob.run(b.hash, b.content);
    for (const e of dump.entities as any[]) insertEntity.run(e.id, e.kind, e.created_at);
    for (const v of dump.versions as any[])
      insertVersion.run(v.version_id, v.entity_id, v.version_no, v.parent_version_id, v.content_hash, v.created_at);
    for (const ev of dump.events as any[]) insertEvent.run(ev.seq, ev.event_id, ev.at, ev.payload);
    for (const d of dump.derived as any[])
      insertDerived.run(d.derived_key, d.algo_version, d.param_fingerprint, d.source_version_ids, d.content_hash, d.status);
    return store;
  }
}
