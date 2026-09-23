import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sha256Hex, stableStringify } from '../domain/determinism';
import type { EntityEnvelope, EntityKind, EntityRef, LedgerEvent, RawSlot } from '../domain/types';

export class CorruptionError extends Error {
  constructor(readonly missing: EntityRef[], readonly fromEntityId: string) {
    super(
      `entity ${fromEntityId} references missing version(s); refusing to fall back to latest: ` +
        missing.map((m) => `${m.entityId}#v${m.version}`).join(', ')
    );
    this.name = 'CorruptionError';
  }
}

interface SchemaRow {
  name: string;
}

export class LedgerStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        at_iso TEXT NOT NULL,
        at_tick INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entities (
        entity_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        case_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        slot TEXT,
        parent_id TEXT,
        blob_hash TEXT NOT NULL,
        refs_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        created_iso TEXT NOT NULL,
        created_tick INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (entity_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_entities_case ON entities(case_id);
      CREATE INDEX IF NOT EXISTS idx_events_case ON events(case_id, seq);
      CREATE TABLE IF NOT EXISTS blobs (
        blob_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
    `);
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as unknown as SchemaRow[];
    if (!tables.some((t) => t.name === 'meta')) throw new Error('migration failed');
  }

  /* --------------------------------- 事件 -------------------------------- */

  nextSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events').get() as { n: number };
    return row.n;
  }

  appendEvent(event: Omit<LedgerEvent, 'seq'> & { seq?: number }): LedgerEvent {
    const seq = event.seq ?? this.nextSeq();
    this.db
      .prepare(
        `INSERT INTO events (seq, event_id, case_id, at_iso, at_tick, type, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(seq, event.eventId, event.caseId, event.at.iso, event.at.tick, event.type, stableStringify(event.payload));
    return { ...event, seq };
  }

  events(caseId: string): LedgerEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE case_id = ? ORDER BY seq')
      .all(caseId) as Array<{
      seq: number;
      event_id: string;
      case_id: string;
      at_iso: string;
      at_tick: number;
      type: LedgerEvent['type'];
      payload: string;
    }>;
    return rows.map((r) => ({
      seq: r.seq,
      eventId: r.event_id,
      caseId: r.case_id,
      at: { iso: r.at_iso, tick: r.at_tick },
      type: r.type,
      payload: JSON.parse(r.payload),
    }));
  }

  allEvents(): LedgerEvent[] {
    const rows = this.db.prepare('SELECT * FROM events ORDER BY seq, case_id').all() as Array<{
      seq: number;
      event_id: string;
      case_id: string;
      at_iso: string;
      at_tick: number;
      type: LedgerEvent['type'];
      payload: string;
    }>;
    return rows.map((r) => ({
      seq: r.seq,
      eventId: r.event_id,
      caseId: r.case_id,
      at: { iso: r.at_iso, tick: r.at_tick },
      type: r.type,
      payload: JSON.parse(r.payload),
    }));
  }

  /* --------------------------------- 实体 -------------------------------- */

  putEntity(envelope: EntityEnvelope): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO entities
          (entity_id, version, case_id, kind, slot, parent_id, blob_hash, refs_json,
           provenance_json, created_iso, created_tick, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        envelope.entityId,
        envelope.version,
        envelope.caseId,
        envelope.kind,
        envelope.slot ?? null,
        envelope.parentId,
        envelope.blobHash,
        stableStringify(envelope.refs),
        stableStringify(envelope.provenance ?? {}),
        envelope.createdAt.iso,
        envelope.createdAt.tick,
        stableStringify(envelope.data)
      );
    this.db
      .prepare('INSERT OR IGNORE INTO blobs (blob_hash, kind, data_json) VALUES (?, ?, ?)')
      .run(envelope.blobHash, envelope.kind, stableStringify(envelope.data));
  }

  getEntity(entityId: string, version?: number): EntityEnvelope | null {
    const row =
      version === undefined
        ? (this.db
            .prepare('SELECT * FROM entities WHERE entity_id = ? ORDER BY version DESC LIMIT 1')
            .get(entityId) as EntityRow | undefined)
        : (this.db
            .prepare('SELECT * FROM entities WHERE entity_id = ? AND version = ?')
            .get(entityId, version) as EntityRow | undefined);
    return row ? rowToEnvelope(row) : null;
  }

  /**
   * 查询实体并解析其全部直接来源引用。
   * 缺少任何被引用版本 => CorruptionError，绝不回退到最新版。
   */
  resolveEntity(entityId: string, version?: number): EntityEnvelope {
    const entity = this.getEntity(entityId, version);
    if (!entity) {
      throw new CorruptionError(
        [{ entityId, version: version ?? 0, kind: 'unknown' as EntityKind, summary: 'entity missing' }],
        entityId
      );
    }
    const missing: EntityRef[] = [];
    for (const ref of entity.refs) {
      const found = this.getEntity(ref.entityId, ref.version);
      if (!found) missing.push(ref);
    }
    if (missing.length) throw new CorruptionError(missing, entity.entityId);
    return entity;
  }

  entities(caseId: string): EntityEnvelope[] {
    const rows = this.db
      .prepare('SELECT * FROM entities WHERE case_id = ? ORDER BY created_tick, entity_id, version')
      .all(caseId) as unknown as EntityRow[];
    return rows.map(rowToEnvelope);
  }

  entityHistory(entityId: string): EntityEnvelope[] {
    const rows = this.db
      .prepare('SELECT * FROM entities WHERE entity_id = ? ORDER BY version')
      .all(entityId) as unknown as EntityRow[];
    return rows.map(rowToEnvelope);
  }

  rawVersions(caseId: string, slot: RawSlot): EntityEnvelope[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM entities WHERE case_id = ? AND slot = ? ORDER BY version`
      )
      .all(caseId, slot) as unknown as EntityRow[];
    return rows.map(rowToEnvelope);
  }

  latestRawVersion(caseId: string, slot: RawSlot): EntityEnvelope | null {
    const row = this.db
      .prepare('SELECT * FROM entities WHERE case_id=? AND slot=? ORDER BY version DESC LIMIT 1')
      .get(caseId, slot) as EntityRow | undefined;
    return row ? rowToEnvelope(row) : null;
  }

  meta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  /* ------------------------------ 导出 / 导入 ----------------------------- */

  exportBundle(): string {
    const events = this.allEvents();
    const entities = (this.db.prepare('SELECT * FROM entities ORDER BY created_tick, entity_id, version').all() as unknown as EntityRow[]).map(
      rowToEnvelope
    );
    return stableStringify({
      format: 'interference-ledger/1',
      exportedAt: new Date(0).toISOString(),
      events,
      entities,
    });
  }

  /** 导入到空库：身份、版本、顺序、来源关系全部按原样恢复。 */
  importBundle(text: string): { events: number; entities: number } {
    const parsed = JSON.parse(text) as {
      format?: string;
      events: LedgerEvent[];
      entities: EntityEnvelope[];
    };
    if (parsed.format !== 'interference-ledger/1') {
      throw new Error('unsupported bundle format: ' + String(parsed.format));
    }
    const count = (
      this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
    ).n;
    if (count > 0) throw new Error('import target database is not empty');
    for (const event of [...parsed.events].sort((a, b) => a.seq - b.seq)) {
      this.appendEvent(event);
    }
    for (const entity of parsed.entities) this.putEntity(entity);
    return { events: parsed.events.length, entities: parsed.entities.length };
  }

  verifyIntegrity(caseId: string): { entityId: string; missing: EntityRef[] }[] {
    const broken: { entityId: string; missing: EntityRef[] }[] = [];
    for (const entity of this.entities(caseId)) {
      const missing = entity.refs.filter((ref) => !this.getEntity(ref.entityId, ref.version));
      if (missing.length) broken.push({ entityId: entity.entityId, missing });
    }
    return broken;
  }

  loadSqliteFile(path: string): { events: number; entities: number } {
    const buf = readFileSync(path);
    if (!buf.subarray(0, 16).toString('latin1').startsWith('SQLite format 3')) {
      throw new Error('not a SQLite database file');
    }
    const foreign = new DatabaseSync(path, { readOnly: true });
    const events = foreign.prepare('SELECT * FROM events ORDER BY seq').all() as unknown[];
    const entities = foreign.prepare('SELECT * FROM entities ORDER BY created_tick').all() as unknown as EntityRow[];
    foreign.close();
    for (const e of events) this.appendEvent(e as never);
    for (const r of entities) this.putEntity(rowToEnvelope(r));
    return { events: events.length, entities: entities.length };
  }
}

interface EntityRow {
  entity_id: string;
  version: number;
  case_id: string;
  kind: EntityKind;
  slot: RawSlot | null;
  parent_id: string | null;
  blob_hash: string;
  refs_json: string;
  provenance_json: string;
  created_iso: string;
  created_tick: number;
  data_json: string;
}

function rowToEnvelope(row: EntityRow): EntityEnvelope {
  return {
    entityId: row.entity_id,
    version: row.version,
    caseId: row.case_id,
    kind: row.kind,
    slot: row.slot ?? undefined,
    parentId: row.parent_id,
    blobHash: row.blob_hash,
    refs: JSON.parse(row.refs_json),
    provenance: JSON.parse(row.provenance_json),
    createdAt: { iso: row.created_iso, tick: row.created_tick },
    data: JSON.parse(row.data_json),
  };
}

export function hashData(data: unknown): string {
  return sha256Hex(data);
}
