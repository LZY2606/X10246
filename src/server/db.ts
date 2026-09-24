import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS blobs (
      blob_id TEXT PRIMARY KEY,
      content TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS input_versions (
      entity_id TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      parent_version_no INTEGER,
      kind TEXT NOT NULL,
      blob_id TEXT NOT NULL REFERENCES blobs(blob_id),
      meta TEXT NOT NULL,
      created_seq INTEGER NOT NULL,
      PRIMARY KEY (entity_id, version_no)
    );
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL UNIQUE,
      type TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS results (
      result_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      algorithm_version TEXT NOT NULL,
      param_fingerprint TEXT NOT NULL,
      source_refs TEXT NOT NULL,
      region TEXT,
      blob_id TEXT NOT NULL REFERENCES blobs(blob_id),
      diagnosis TEXT,
      created_seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS result_history (
      result_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (result_id, seq)
    );
    CREATE TABLE IF NOT EXISTS decisions (
      decision_id TEXT PRIMARY KEY,
      result_id TEXT,
      action TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS locks (
      lock_id TEXT PRIMARY KEY,
      region TEXT NOT NULL,
      k_offsets TEXT NOT NULL,
      basis_result_id TEXT,
      status TEXT NOT NULL,
      created_seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lock_history (
      lock_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (lock_id, seq)
    );
  `);
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  if (!row) {
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION));
  } else if (Number(row.value) !== SCHEMA_VERSION) {
    throw new Error(`unsupported schema version ${row.value}`);
  }
  return db;
}
