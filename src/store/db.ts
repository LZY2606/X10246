import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY,
  content TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inputs (
  input_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  parent_version INTEGER,
  blob_hash TEXT NOT NULL REFERENCES blobs(hash),
  digest TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  PRIMARY KEY (input_id, version)
);
CREATE TABLE IF NOT EXISTS derived (
  derived_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  params_fingerprint TEXT NOT NULL,
  sources TEXT NOT NULL,          -- JSON: SourceRef[] 与 DerivedSourceRef[] 的并集
  payload_hash TEXT NOT NULL REFERENCES blobs(hash),
  digest TEXT NOT NULL,
  status TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS locks (
  lock_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  region TEXT NOT NULL,           -- JSON: 像素索引数组
  k_values TEXT NOT NULL,         -- JSON: 与 region 对齐的整周数
  status TEXT NOT NULL,           -- active | released
  created_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  at INTEGER NOT NULL,            -- 虚拟时钟毫秒
  payload TEXT NOT NULL
);
`;

export function openDb(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}
