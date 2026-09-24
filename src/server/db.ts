import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY,
  content TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS input_versions (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  parent_version INTEGER,
  blob_hash TEXT NOT NULL REFERENCES blobs(hash),
  unit TEXT,
  frame TEXT,
  digest TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  params_fingerprint TEXT NOT NULL,
  source_refs TEXT NOT NULL,
  status TEXT NOT NULL,
  blob_hash TEXT NOT NULL REFERENCES blobs(hash),
  diagnostics TEXT NOT NULL,
  scenario TEXT,
  adopted INTEGER NOT NULL DEFAULT 0,
  created_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS result_status_history (
  result_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (result_id, seq)
);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  rationale TEXT,
  payload TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS locks (
  id TEXT PRIMARY KEY,
  region TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  ts INTEGER NOT NULL
);
`;

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
