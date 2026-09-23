import { DatabaseSync } from 'node:sqlite';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS blobs (
  digest TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  media_type TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS inputs (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  parent_version INTEGER,
  blob_digest TEXT NOT NULL,
  unit TEXT, frame TEXT, label TEXT,
  created_seq INTEGER NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE TABLE IF NOT EXISTS derivations (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  params_fingerprint TEXT NOT NULL,
  source_refs TEXT NOT NULL,
  blob_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'current',
  created_seq INTEGER NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE TABLE IF NOT EXISTS candidate_status (
  candidate_key TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  reason TEXT,
  event_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS locks (
  region_id TEXT PRIMARY KEY,
  candidate_key TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  at TEXT NOT NULL
);
`;

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
