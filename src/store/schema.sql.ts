export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blobs (
  blob_id TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  byte_count INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  entity_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entity_versions (
  entity_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  parent_version INTEGER,
  kind TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (entity_id, version),
  FOREIGN KEY (entity_id) REFERENCES entities(entity_id),
  FOREIGN KEY (blob_id) REFERENCES blobs(blob_id)
);

CREATE TABLE IF NOT EXISTS refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_entity TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  source_role TEXT NOT NULL,
  target_entity TEXT NOT NULL,
  target_version INTEGER NOT NULL,
  target_role TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  situation TEXT,
  run_id TEXT,
  subject_entity TEXT,
  subject_version INTEGER,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pointers (
  name TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  situation TEXT NOT NULL,
  mode TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  fragment_blob_ids TEXT NOT NULL,
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_refs_target ON refs(target_entity, target_version);
CREATE INDEX IF NOT EXISTS idx_versions_blob ON entity_versions(blob_id);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
`;
