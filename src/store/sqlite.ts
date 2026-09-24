import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Cid, FringeEvent, StoredEntity, SourceRef } from '../domain/types';
import { canonicalJson, sha256Hex } from '../domain/hashing';

/**
 * SQLite 持久层：对象表（不可变内容）+ 事件表（哈希链）+ 引用表。
 * 对象一经写入永不更新；“当前版本”由事件回放决定。
 */
export class FringeStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        algorithm_version TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS objects (
        id TEXT PRIMARY KEY,
        lineage_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        kind TEXT NOT NULL,
        content_json TEXT NOT NULL,
        digest TEXT NOT NULL,
        created_seq INTEGER NOT NULL,
        UNIQUE(lineage_id, version)
      );

      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        at INTEGER NOT NULL,
        type TEXT NOT NULL,
        hash TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        entity_ids_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS refs (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        to_lineage TEXT NOT NULL,
        to_version INTEGER NOT NULL,
        to_digest TEXT NOT NULL,
        kind TEXT NOT NULL,
        slot TEXT NOT NULL,
        PRIMARY KEY (from_id, slot, to_id)
      );

      CREATE INDEX IF NOT EXISTS idx_objects_lineage ON objects(lineage_id, version);
      CREATE INDEX IF NOT EXISTS idx_refs_to ON refs(to_id);
    `);
  }

  saveProject(meta: { projectId: Cid; name: string; createdAt: number; algorithmVersion: string }): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO projects(project_id, name, created_at, algorithm_version) VALUES (?,?,?,?)'
    ).run(meta.projectId, meta.name, meta.createdAt, meta.algorithmVersion);
  }

  getProject(projectId: Cid): { project_id: string; name: string; created_at: number; algorithm_version: string } | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as
      | { project_id: string; name: string; created_at: number; algorithm_version: string }
      | undefined;
  }

  hasObject(id: Cid): boolean {
    return (this.db.prepare('SELECT 1 FROM objects WHERE id = ?').get(id) ?? null) !== null;
  }

  /** 不可变写入：同 id 已存在时校验内容一致，冲突即损坏 */
  putObject(entity: StoredEntity, createdSeq: number): void {
    const versioned = entity as { id: Cid; lineageId: string; version: number; kind: string };
    const content = stripIdentity(entity);
    const digest = (entity.id.split('_').pop() ?? '');
    const existing = this.db.prepare('SELECT digest FROM objects WHERE id = ?').get(versioned.id) as
      | { digest: string } | undefined;
    if (existing) {
      if (existing.digest !== digest) {
        throw new Error(`CORRUPTION: object ${versioned.id} re-written with different content`);
      }
      return;
    }
    this.db.prepare(
      `INSERT INTO objects(id, lineage_id, version, kind, content_json, digest, created_seq)
       VALUES (?,?,?,?,?,?,?)`
    ).run(
      versioned.id, versioned.lineageId, versioned.version, versioned.kind,
      JSON.stringify(content), digest, createdSeq
    );
  }

  getObject(id: Cid): StoredEntity {
    const row = this.db.prepare('SELECT content_json FROM objects WHERE id = ?').get(id) as
      | { content_json: string } | undefined;
    if (!row) throw new Error(`CORRUPTION: missing referenced object ${id}`);
    const content = JSON.parse(row.content_json) as Record<string, unknown>;
    return { ...content, id } as StoredEntity;
  }

  listObjects(): { id: Cid; lineageId: string; version: number; kind: string; digest: string; createdSeq: number }[] {
    return (this.db.prepare(
      'SELECT id, lineage_id AS lineageId, version, kind, digest, created_seq AS createdSeq FROM objects ORDER BY created_seq, lineage_id, version'
    ).all() as { id: Cid; lineageId: string; version: number; kind: string; digest: string; createdSeq: number }[]);
  }

  putRefs(fromId: Cid, refs: (SourceRef & { slot: string })[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO refs(from_id, to_id, to_lineage, to_version, to_digest, kind, slot)
       VALUES (?,?,?,?,?,?,?)`
    );
    for (const r of refs) {
      stmt.run(fromId, r.entityId, r.lineageId, r.version, r.digest, r.kind, r.slot);
    }
  }

  getRefs(fromId: Cid): (SourceRef & { slot: string })[] {
    return (this.db.prepare(
      `SELECT to_id AS entityId, to_lineage AS lineageId, to_version AS version,
              to_digest AS digest, kind, slot FROM refs WHERE from_id = ? ORDER BY slot`
    ).all(fromId) as (SourceRef & { slot: string })[]);
  }

  appendEvent(evt: FringeEvent): void {
    this.db.prepare(
      `INSERT INTO events(seq, id, at, type, hash, prev_hash, payload_json, entity_ids_json)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(evt.seq, evt.id, evt.at, evt.type, evt.hash, evt.prevHash,
      JSON.stringify(evt.payload), JSON.stringify(evt.entityIds));
  }

  listEvents(): FringeEvent[] {
    const rows = this.db.prepare(
      'SELECT seq, id, at, type, hash, prev_hash, payload_json, entity_ids_json FROM events ORDER BY seq'
    ).all() as {
      seq: number; id: string; at: number; type: string; hash: string;
      prev_hash: string; payload_json: string; entity_ids_json: string;
    }[];
    return rows.map((r) => ({
      seq: r.seq, id: r.id, at: r.at, type: r.type as FringeEvent['type'],
      hash: r.hash, prevHash: r.prev_hash,
      payload: JSON.parse(r.payload_json),
      entityIds: JSON.parse(r.entity_ids_json)
    }));
  }

  maxSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM events').get() as { m: number };
    return row.m;
  }

  /** 完整性：哈希链连续、引用齐全且摘要一致；任何断裂抛 CORRUPTION */
  verifyIntegrity(): void {
    let prevHash = 'GENESIS';
    for (const evt of this.listEvents()) {
      if (evt.prevHash !== prevHash) {
        throw new Error(`CORRUPTION: broken event hash chain at seq ${evt.seq}`);
      }
      const recomputed = eventHash(evt.prevHash, evt.seq, evt.at, evt.type, evt.payload);
      if (recomputed !== evt.hash) {
        throw new Error(`CORRUPTION: event hash mismatch at seq ${evt.seq}`);
      }
      prevHash = evt.hash;
    }
    for (const obj of this.listObjects()) {
      const entity = this.getObject(obj.id) as unknown as { provenance?: { sources?: SourceRef[] } };
      const refs = this.getRefs(obj.id);
      for (const r of refs) {
        const target = this.db.prepare('SELECT digest, lineage_id, version FROM objects WHERE id = ?').get(r.entityId) as
          | { digest: string; lineage_id: string; version: number } | undefined;
        if (!target) throw new Error(`CORRUPTION: dangling reference ${obj.id} -> ${r.entityId}`);
        if (target.digest !== r.digest) throw new Error(`CORRUPTION: ref digest mismatch ${obj.id} -> ${r.entityId}`);
        if (target.lineage_id !== r.lineageId || target.version !== r.version) {
          throw new Error(`CORRUPTION: ref version mismatch ${obj.id} -> ${r.entityId}`);
        }
      }
      if (entity.provenance && entity.provenance.sources.length !== 0 && refs.length === 0) {
        throw new Error(`CORRUPTION: derived object ${obj.id} missing stored refs`);
      }
    }
  }

  transaction<T>(fn: () => T): T {
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
}

/** 落库内容不含身份字段；身份由内容决定，导出/再导入后稳定 */
function stripIdentity(entity: StoredEntity): unknown {
  const { id, lineageId, version, parentId, createdAtEvent, ...rest } = entity as Record<string, unknown>;
  void id; void lineageId; void version; void parentId; void createdAtEvent;
  return rest;
}

export function eventHash(prevHash: string, seq: number, at: number, type: string, payload: unknown): string {
  return sha256Hex(`${prevHash}|${seq}|${at}|${type}|${canonicalJson(payload)}`);
}
