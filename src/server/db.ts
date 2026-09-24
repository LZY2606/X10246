import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 不可变原始片段：同内容只存一份（最小输入与组合输入共享）
CREATE TABLE IF NOT EXISTS fragments (
  fragment_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS input_refs (
  case_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (case_key, kind, version)
);
CREATE TABLE IF NOT EXISTS entities (
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  parent_entity_id TEXT,
  status TEXT NOT NULL,
  algo TEXT,
  param_fingerprint TEXT,
  content_hash TEXT NOT NULL,
  fragment_id TEXT,
  content TEXT,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by_event TEXT,
  scenario TEXT,
  PRIMARY KEY (entity_id, version)
);
CREATE TABLE IF NOT EXISTS edges (
  from_entity_id TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  to_entity_id TEXT NOT NULL,
  to_version INTEGER NOT NULL,
  to_kind TEXT,
  PRIMARY KEY (from_entity_id, from_version, to_entity_id)
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  case_key TEXT,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  rationale TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS locks (
  lock_id TEXT PRIMARY KEY,
  case_key TEXT NOT NULL,
  component_id INTEGER NOT NULL,
  solution_entity_id TEXT NOT NULL,
  solution_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by_event TEXT NOT NULL,
  note TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS diagnostics (
  diag_id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  entity_ref TEXT,
  payload TEXT NOT NULL
);
`;
