export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blobs (
  content_hash TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  entity_id TEXT NOT NULL,
  version_id TEXT NOT NULL PRIMARY KEY,
  parent_version_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  algorithm_version TEXT,
  parameter_fingerprint TEXT,
  created_at TEXT NOT NULL,
  superseded_by_version_id TEXT,
  stale_reason TEXT,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  version_id TEXT NOT NULL,
  ref_kind TEXT NOT NULL,
  ref_entity_id TEXT NOT NULL,
  ref_version_id TEXT NOT NULL,
  ref_content_hash TEXT NOT NULL,
  fragment TEXT,
  ord INTEGER NOT NULL,
  PRIMARY KEY (version_id, ord)
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER NOT NULL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  summary TEXT NOT NULL,
  adopted INTEGER NOT NULL,
  parent_event_id TEXT,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_affected (
  seq INTEGER NOT NULL,
  ref_version_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  PRIMARY KEY (seq, ord)
);

CREATE TABLE IF NOT EXISTS event_asof (
  seq INTEGER NOT NULL,
  entity_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  ord INTEGER NOT NULL,
  PRIMARY KEY (seq, ord)
);

CREATE INDEX IF NOT EXISTS idx_entities_entity ON entities(entity_id);
CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);
CREATE INDEX IF NOT EXISTS idx_sources_ref ON sources(ref_version_id);
`;
