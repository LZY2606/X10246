import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DomainEvent, EventType } from '../shared/contract';

export interface VersionRow {
  versionId: string;
  entityId: string;
  kind: string;
  parentVersionId: string | null;
  seq: number;
  summary: string;
  content: unknown;
}

export interface DerivedRow {
  versionId: string;
  algorithmVersion: string;
  paramsFingerprint: string;
  sourceRefs: string[];
  stale: boolean;
  staleReason: string | null;
}

export type Clock = () => number;

export class Store {
  readonly db: DatabaseSync;
  private clock: Clock;

  constructor(path: string, clock: Clock = () => Date.now()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.clock = clock;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS blobs (
        hash TEXT PRIMARY KEY,
        content TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        version_id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        parent_version_id TEXT,
        seq INTEGER NOT NULL,
        summary TEXT NOT NULL,
        content TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_versions_entity ON versions(entity_id, seq);
      CREATE TABLE IF NOT EXISTS derived (
        version_id TEXT PRIMARY KEY REFERENCES versions(version_id),
        algorithm_version TEXT NOT NULL,
        params_fingerprint TEXT NOT NULL,
        source_refs TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0,
        stale_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        type TEXT NOT NULL,
        at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
    `);
  }

  close() { this.db.close(); }

  // ---------- 事件（只追加） ----------
  appendEvent(type: EventType, payload: Record<string, unknown>): DomainEvent {
    const at = this.clock();
    const eventId = `ev_${type}_${at}_${Math.random().toString(36).slice(2, 8)}`;
    const stmt = this.db.prepare(
      'INSERT INTO events (event_id, type, at, payload) VALUES (?, ?, ?, ?)',
    );
    const r = stmt.run(eventId, type, at, JSON.stringify(payload));
    return { seq: Number(r.lastInsertRowid), eventId, type, at, payload };
  }

  events(upToSeq?: number): DomainEvent[] {
    const rows = (upToSeq == null
      ? this.db.prepare('SELECT * FROM events ORDER BY seq').all()
      : this.db.prepare('SELECT * FROM events WHERE seq <= ? ORDER BY seq').all(upToSeq)
    ) as unknown as { seq: number; event_id: string; type: string; at: number; payload: string }[];
    return rows.map((r) => ({
      seq: r.seq, eventId: r.event_id, type: r.type as EventType, at: r.at,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    }));
  }

  // ---------- 原始片段（内容寻址，只存一份） ----------
  putBlob(hash: string, content: unknown): void {
    this.db.prepare('INSERT OR IGNORE INTO blobs (hash, content) VALUES (?, ?)')
      .run(hash, JSON.stringify(content));
  }

  getBlob(hash: string): unknown | null {
    const row = this.db.prepare('SELECT content FROM blobs WHERE hash = ?').get(hash) as { content: string } | undefined;
    return row ? JSON.parse(row.content) : null;
  }

  allBlobs(): { hash: string; content: unknown }[] {
    const rows = this.db.prepare('SELECT hash, content FROM blobs ORDER BY hash').all() as unknown as { hash: string; content: string }[];
    return rows.map((r) => ({ hash: r.hash, content: JSON.parse(r.content) }));
  }

  // ---------- 版本（不可覆盖：同 versionId 重复写入需内容一致，否则报错） ----------
  putVersion(v: VersionRow): void {
    const existing = this.db.prepare('SELECT content FROM versions WHERE version_id = ?').get(v.versionId) as { content: string } | undefined;
    const serialized = JSON.stringify(v.content);
    if (existing) {
      if (existing.content !== serialized) {
        throw new Error(`IMMUTABLE_VIOLATION: version ${v.versionId} 已存在且内容不同，禁止覆盖`);
      }
      return; // 幂等重放（导出再导入）
    }
    this.db.prepare(
      'INSERT INTO versions (version_id, entity_id, kind, parent_version_id, seq, summary, content) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(v.versionId, v.entityId, v.kind, v.parentVersionId, v.seq, v.summary, serialized);
  }

  getVersion(versionId: string): VersionRow | null {
    const r = this.db.prepare('SELECT * FROM versions WHERE version_id = ?').get(versionId) as
      | { version_id: string; entity_id: string; kind: string; parent_version_id: string | null; seq: number; summary: string; content: string }
      | undefined;
    if (!r) return null;
    return {
      versionId: r.version_id, entityId: r.entity_id, kind: r.kind,
      parentVersionId: r.parent_version_id, seq: r.seq, summary: r.summary,
      content: JSON.parse(r.content),
    };
  }

  /** 某实体在 asOfSeq 时刻可见的版本（不取“最新版”兜底，调用方必须显式） */
  versionOf(entityId: string, asOfSeq?: number): VersionRow | null {
    const rows = this.versionsOf(entityId, asOfSeq);
    return rows.length ? rows[rows.length - 1] : null;
  }

  versionsOf(entityId: string, asOfSeq?: number): VersionRow[] {
    const rows = (asOfSeq == null
      ? this.db.prepare('SELECT * FROM versions WHERE entity_id = ? ORDER BY seq').all(entityId)
      : this.db.prepare('SELECT * FROM versions WHERE entity_id = ? AND seq <= ? ORDER BY seq').all(entityId, asOfSeq)
    ) as unknown as { version_id: string; entity_id: string; kind: string; parent_version_id: string | null; seq: number; summary: string; content: string }[];
    return rows.map((r) => ({
      versionId: r.version_id, entityId: r.entity_id, kind: r.kind,
      parentVersionId: r.parent_version_id, seq: r.seq, summary: r.summary,
      content: JSON.parse(r.content),
    }));
  }

  allVersions(): VersionRow[] {
    const rows = this.db.prepare('SELECT * FROM versions ORDER BY seq, version_id').all() as unknown as
      { version_id: string; entity_id: string; kind: string; parent_version_id: string | null; seq: number; summary: string; content: string }[];
    return rows.map((r) => ({
      versionId: r.version_id, entityId: r.entity_id, kind: r.kind,
      parentVersionId: r.parent_version_id, seq: r.seq, summary: r.summary,
      content: JSON.parse(r.content),
    }));
  }

  // ---------- 派生结果元数据 ----------
  putDerived(d: DerivedRow): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO derived (version_id, algorithm_version, params_fingerprint, source_refs, stale, stale_reason) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(d.versionId, d.algorithmVersion, d.paramsFingerprint, JSON.stringify(d.sourceRefs), d.stale ? 1 : 0, d.staleReason);
  }

  getDerived(versionId: string): DerivedRow | null {
    const r = this.db.prepare('SELECT * FROM derived WHERE version_id = ?').get(versionId) as
      | { version_id: string; algorithm_version: string; params_fingerprint: string; source_refs: string; stale: number; stale_reason: string | null }
      | undefined;
    if (!r) return null;
    return {
      versionId: r.version_id, algorithmVersion: r.algorithm_version,
      paramsFingerprint: r.params_fingerprint, sourceRefs: JSON.parse(r.source_refs) as string[],
      stale: !!r.stale, staleReason: r.stale_reason,
    };
  }

  markStale(versionId: string, reason: string, asOfSeq?: number): void {
    // asOfSeq 仅用于调用方语义；过期标记本身是当前事实
    void asOfSeq;
    this.db.prepare('UPDATE derived SET stale = 1, stale_reason = ? WHERE version_id = ?').run(reason, versionId);
  }

  derivedAll(): DerivedRow[] {
    const rows = this.db.prepare('SELECT * FROM derived').all() as unknown as
      { version_id: string; algorithm_version: string; params_fingerprint: string; source_refs: string; stale: number; stale_reason: string | null }[];
    return rows.map((r) => ({
      versionId: r.version_id, algorithmVersion: r.algorithm_version,
      paramsFingerprint: r.params_fingerprint, sourceRefs: JSON.parse(r.source_refs) as string[],
      stale: !!r.stale, staleReason: r.stale_reason,
    }));
  }

  /** 找出直接引用了某版本的所有派生结果 */
  dependentsOf(sourceVersionId: string): DerivedRow[] {
    return this.derivedAll().filter((d) => d.sourceRefs.includes(sourceVersionId));
  }

  reset(): void {
    this.db.exec('DELETE FROM events; DELETE FROM derived; DELETE FROM versions; DELETE FROM blobs;');
  }
}
