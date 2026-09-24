import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- 内容寻址的不可变原始/派生内容块（共享片段只存一份）
  CREATE TABLE IF NOT EXISTS blobs (
    content_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    json TEXT NOT NULL,
    byte_length INTEGER NOT NULL
  );

  -- 实体信封（同一逻辑实体多版本共存）
  CREATE TABLE IF NOT EXISTS entities (
    id TEXT NOT NULL,
    version INTEGER NOT NULL,
    entity_type TEXT NOT NULL,
    kind TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    parent_version_id TEXT,
    committed_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    algorithm_version TEXT,
    parameter_fingerprint TEXT,
    stale INTEGER NOT NULL DEFAULT 0,
    superseded_by TEXT,
    PRIMARY KEY (id, version)
  );

  -- 直接来源引用：锁定实体+版本+内容摘要，缺失/不匹配即损坏
  CREATE TABLE IF NOT EXISTS sources (
    owner_id TEXT NOT NULL,
    owner_version INTEGER NOT NULL,
    ref_index INTEGER NOT NULL,
    source_entity_id TEXT NOT NULL,
    source_version INTEGER NOT NULL,
    source_content_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    PRIMARY KEY (owner_id, owner_version, ref_index)
  );

  -- append-only 领域事件（状态机）
  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    at TEXT NOT NULL,
    project_id TEXT NOT NULL,
    causation_id TEXT,
    payload_json TEXT NOT NULL
  );

  -- 人工裁定
  CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    target_entity_id TEXT NOT NULL,
    target_version INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    reason TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    decider TEXT NOT NULL,
    adjustment_json TEXT,
    conflicts_with TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    event_seq INTEGER
  );

  -- 局部解读锁定
  CREATE TABLE IF NOT EXISTS locks (
    id TEXT PRIMARY KEY,
    scope_json TEXT NOT NULL,
    tree_id TEXT NOT NULL,
    root_integer INTEGER NOT NULL,
    locked_entity_id TEXT NOT NULL,
    locked_version INTEGER NOT NULL,
    locked_at TEXT NOT NULL,
    locker TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    conflict_reason TEXT,
    event_seq INTEGER
  );

  -- 机器可读的判断事件（被采纳/未采纳结论的依据档案）
  CREATE TABLE IF NOT EXISTS judgments (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    scenario TEXT,
    subject TEXT NOT NULL,
    rule TEXT NOT NULL,
    outcome TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    refs_json TEXT NOT NULL,
    event_seq INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);
  CREATE INDEX IF NOT EXISTS idx_sources_src ON sources(source_entity_id, source_version);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  `);
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, value);
}
