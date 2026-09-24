import type { DatabaseSync } from 'node:sqlite';
import { reviveGrids } from '../core/grid';
import type {
  EdgeRecord, EntityKind, EntityRecord, EventRecord, EventType, LockRecord,
} from '../shared/domain';
import type { Clock } from './clock';
import { contentHashOf } from '../core/hash';


/** NaN/Infinity -> null（网格未知像素），导出与存储共用 */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}

export class Store {
  constructor(public db: DatabaseSync, public clock: Clock) {}

  putFragment(fragmentId: string, kind: string, contentHash: string, content: unknown): void {
    this.db.prepare(`INSERT OR IGNORE INTO fragments(fragment_id,kind,content_hash,content) VALUES(?,?,?,?)`)
      .run(fragmentId, kind, contentHash, JSON.stringify(jsonSafe(content)));
  }
  getFragment(fragmentId: string): unknown {
    const row = this.db.prepare('SELECT content FROM fragments WHERE fragment_id=?').get(fragmentId) as { content: string } | undefined;
    return row ? reviveGrids(JSON.parse(row.content)) : null;
  }
  setInputRef(caseKey: string, kind: string, version: number, entityId: string, entityVersion: number): void {
    this.db.prepare(`INSERT OR REPLACE INTO input_refs(case_key,kind,version,entity_id,entity_version) VALUES(?,?,?,?,?)`)
      .run(caseKey, kind, version, entityId, entityVersion);
  }
  getInputRef(caseKey: string, kind: string, version: number): { entityId: string; entityVersion: number } | null {
    const row = this.db.prepare('SELECT entity_id, entity_version FROM input_refs WHERE case_key=? AND kind=? AND version=?').get(caseKey, kind, version) as { entity_id: string; entity_version: number } | undefined;
    return row ? { entityId: row.entity_id, entityVersion: row.entity_version } : null;
  }
  listInputRefs(caseKey: string): Array<{ kind: string; version: number; entityId: string; entityVersion: number }> {
    return (this.db.prepare('SELECT kind,version,entity_id,entity_version FROM input_refs WHERE case_key=? ORDER BY kind,version').all(caseKey) as Array<{ kind: string; version: number; entity_id: string; entity_version: number }>)
      .map((r) => ({ kind: r.kind, version: r.version, entityId: r.entity_id, entityVersion: r.entity_version }));
  }

    getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }
  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value);
  }

  /** 提交不可覆盖输入：内容寻址；同内容只存一份，返回记录与是否新建 */
  insertEntity(rec: Omit<EntityRecord, 'createdAt'> & { createdAt?: string }): { record: EntityRecord; created: boolean } {
    const at = rec.createdAt ?? this.clock.now();
    const existing = this.getEntity(rec.entityId, rec.version);
    if (existing) return { record: existing, created: false };
    this.db.prepare(`INSERT INTO entities
      (entity_id,kind,version,parent_entity_id,status,algo,param_fingerprint,content_hash,fragment_id,content,summary,created_at,created_by_event,scenario)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      rec.entityId, rec.kind, rec.version, rec.parentEntityId, rec.status, rec.algo,
      rec.paramFingerprint, rec.contentHash, rec.fragmentId ?? null,
      rec.fragmentId ? null : JSON.stringify(jsonSafe(rec.content)), rec.summary, at,
      rec.createdByEvent, rec.scenario,
    );
    return { record: { ...rec, createdAt: at }, created: true };
  }

  getEntity(entityId: string, version: number): EntityRecord | null {
    const row = this.db.prepare('SELECT * FROM entities WHERE entity_id=? AND version=?').get(entityId, version) as EntityRow | undefined;
    return row ? this.resolveRecord(toRecord(row)) : null;
  }
  latestEntity(entityId: string): EntityRecord | null {
    const row = this.db.prepare('SELECT * FROM entities WHERE entity_id=? ORDER BY version DESC LIMIT 1').get(entityId) as EntityRow | undefined;
    return row ? this.resolveRecord(toRecord(row)) : null;
  }
  private resolveRecord(rec: EntityRecord): EntityRecord {
    if (rec.fragmentId && rec.content === undefined) {
      return { ...rec, content: this.getFragment(rec.fragmentId) };
    }
    return rec;
  }
  latestEntity(entityId: string): EntityRecord | null {
    const row = this.db.prepare('SELECT * FROM entities WHERE entity_id=? ORDER BY version DESC LIMIT 1').get(entityId) as EntityRow | undefined;
    return row ? toRecord(row) : null;
  }
  listEntities(kind?: EntityKind): EntityRecord[] {
    const rows = kind
      ? this.db.prepare('SELECT * FROM entities WHERE kind=? ORDER BY created_at, entity_id, version').all(kind) as EntityRow[]
      : this.db.prepare('SELECT * FROM entities ORDER BY created_at, entity_id, version').all() as EntityRow[];
    return rows.map((r) => this.resolveRecord(toRecord(r)));
  }
  setStatus(entityId: string, version: number, status: EntityRecord['status']): void {
    this.db.prepare('UPDATE entities SET status=? WHERE entity_id=? AND version=?').run(status, entityId, version);
  }

  insertEdge(e: EdgeRecord): void {
    this.db.prepare(`INSERT OR IGNORE INTO edges(from_entity_id,from_version,to_entity_id,to_version,to_kind)
      VALUES(?,?,?,?,?)`).run(e.fromEntityId, e.fromVersion, e.toEntityId, e.toVersion, e.toKind ?? null);
  }
  edgesOf(entityId: string, version: number): EdgeRecord[] {
    return (this.db.prepare('SELECT * FROM edges WHERE from_entity_id=? AND from_version=? ORDER BY to_entity_id')
      .all(entityId, version) as EdgeRow[]).map((r) => ({
      fromEntityId: r.from_entity_id, fromVersion: r.from_version,
      toEntityId: r.to_entity_id, toVersion: r.to_version, toKind: r.to_kind,
    }));
  }
  allEdges(): EdgeRecord[] {
    return (this.db.prepare('SELECT * FROM edges').all() as EdgeRow[]).map((r) => ({
      fromEntityId: r.from_entity_id, fromVersion: r.from_version,
      toEntityId: r.to_entity_id, toVersion: r.to_version, toKind: r.to_kind,
    }));
  }

  appendEvent(type: EventType, actor: string, rationale: string, payload: Record<string, unknown>): EventRecord {
    const seqRow = this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS s FROM events').get() as { s: number };
    const seq = seqRow.s;
    const at = this.clock.now();
    const eventId = `evt_${contentHashOf([seq, type, at, actor, rationale, payload])}`;
    this.db.prepare('INSERT INTO events(event_id,seq,at,type,actor,rationale,payload) VALUES(?,?,?,?,?,?,?)')
      .run(eventId, seq, at, type, actor, rationale, JSON.stringify(jsonSafe(payload)));
    return { eventId, seq, at, type, actor, rationale, payload };
  }
  listEvents(): EventRecord[] {
    const rows = this.db.prepare('SELECT * FROM events ORDER BY seq').all() as EventRow[];
    return rows.map((r) => ({
      eventId: r.event_id, seq: r.seq, at: r.at, type: r.type, actor: r.actor,
      rationale: r.rationale, payload: JSON.parse(r.payload),
    }));
  }

  insertLock(lock: LockRecord): void {
    this.db.prepare(`INSERT OR REPLACE INTO locks(lock_id,component_id,solution_entity_id,solution_version,status,created_at,created_by_event,note)
      VALUES(?,?,?,?,?,?,?,?)`).run(lock.lockId, lock.componentId, lock.solutionEntityId, lock.solutionVersion,
      lock.status, lock.createdAt, lock.createdByEvent, lock.note);
  }
  listLocks(): LockRecord[] {
    return (this.db.prepare('SELECT * FROM locks ORDER BY created_at').all() as LockRow[]).map((r) => ({
      lockId: r.lock_id, componentId: r.component_id, solutionEntityId: r.solution_entity_id,
      solutionVersion: r.solution_version, status: r.status, createdAt: r.created_at,
      createdByEvent: r.created_by_event, note: r.note,
    }));
  }

  insertDiagnostic(code: string, message: string, entityRef: string | null, payload: Record<string, unknown>): void {
    const diagId = `diag_${contentHashOf([code, message, entityRef, payload])}`;
    this.db.prepare('INSERT OR IGNORE INTO diagnostics(diag_id,at,code,message,entity_ref,payload) VALUES(?,?,?,?,?,?)')
      .run(diagId, this.clock.now(), code, message, entityRef, JSON.stringify(jsonSafe(payload)));
  }
  listDiagnostics() {
    return (this.db.prepare('SELECT * FROM diagnostics ORDER BY at').all() as Array<{
      diag_id: string; at: string; code: string; message: string; entity_ref: string | null; payload: string;
    }>).map((r) => ({
      diagId: r.diag_id, at: r.at, code: r.code, message: r.message,
      entityRef: r.entity_ref, payload: JSON.parse(r.payload),
    }));
  }

  /** 引用完整性：缺少引用直接报损坏，不回退最新版 */
  verifyIntegrity(): string[] {
    const errors: string[] = [];
    const have = new Set((this.db.prepare('SELECT entity_id, version FROM entities').all() as Array<{ entity_id: string; version: number }>)
      .map((r) => `${r.entity_id}@${r.version}`));
    for (const e of this.allEdges()) {
      if (!have.has(`${e.toEntityId}@${e.toVersion}`)) {
        errors.push(`missing-reference: ${e.fromEntityId}@${e.fromVersion} -> ${e.toEntityId}@${e.toVersion}`);
      }
    }
    for (const row of this.db.prepare('SELECT entity_id, version, created_by_event FROM entities').all() as Array<{
      entity_id: string; version: number; created_by_event: string | null;
    }>) {
      if (row.created_by_event) {
        const ev = this.db.prepare('SELECT 1 FROM events WHERE event_id=?').get(row.created_by_event);
        if (!ev) errors.push(`missing-event: ${row.entity_id}@${row.version} created_by ${row.created_by_event}`);
      }
    }
    for (const l of this.listLocks()) {
      if (!have.has(`${l.solutionEntityId}@${l.solutionVersion}`)) {
        errors.push(`missing-reference: lock ${l.lockId} -> ${l.solutionEntityId}@${l.solutionVersion}`);
      }
    }
    return errors;
  }

  clearAll(): void {
    this.db.exec('DELETE FROM edges; DELETE FROM entities; DELETE FROM events; DELETE FROM locks; DELETE FROM diagnostics; DELETE FROM meta;');
  }
}

interface EntityRow {
  entity_id: string; kind: EntityKind; version: number; parent_entity_id: string | null;
  status: EntityRecord['status']; algo: string | null; toKind?: string; param_fingerprint: string | null;
  content_hash: string; fragment_id: string | null; content: string | null; summary: string; created_at: string;
  created_by_event: string | null; scenario: string | null;
}
interface EdgeRow { from_entity_id: string; from_version: number; to_entity_id: string; to_version: number; to_kind: string | null }
interface EventRow { event_id: string; seq: number; at: string; type: EventType; actor: string; rationale: string; payload: string }
interface LockRow {
  lock_id: string; component_id: number; solution_entity_id: string; solution_version: number;
  status: string; created_at: string; created_by_event: string; note: string;
}

function toRecord(r: EntityRow): EntityRecord {
  return {
    entityId: r.entity_id, kind: r.kind, version: r.version, parentEntityId: r.parent_entity_id,
    status: r.status, algo: r.algo, paramFingerprint: r.param_fingerprint,
    contentHash: r.content_hash, content: r.content != null ? reviveGrids(JSON.parse(r.content)) : undefined, fragmentId: r.fragment_id, summary: r.summary,
    createdAt: r.created_at, createdByEvent: r.created_by_event, scenario: r.scenario,
  };
}


