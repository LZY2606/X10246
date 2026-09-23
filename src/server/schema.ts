export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Immutable content blobs, deduplicated by sha256 (shared fragments stored once).
CREATE TABLE IF NOT EXISTS blobs (
  sha256 TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL,
  content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  clock_now INTEGER NOT NULL,
  event_seq INTEGER NOT NULL DEFAULT 0,
  seed INTEGER NOT NULL
);

-- Raw immutable inputs, versioned per lineage with parent links.
CREATE TABLE IF NOT EXISTS raw_versions (
  project_id TEXT NOT NULL,
  lineage TEXT NOT NULL,
  version INTEGER NOT NULL,
  parent_version INTEGER,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  payload TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  submitted_by TEXT NOT NULL,
  note TEXT NOT NULL,
  PRIMARY KEY (project_id, lineage, version),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE INDEX IF NOT EXISTS idx_raw_project ON raw_versions(project_id);

CREATE TABLE IF NOT EXISTS events (
  project_id TEXT NOT NULL,
  event_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL,
  parent_event_id TEXT,
  seq_order INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, seq_order);

CREATE TABLE IF NOT EXISTS event_references (
  project_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  ref_order INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  version INTEGER,
  sha256 TEXT NOT NULL,
  summary TEXT NOT NULL,
  PRIMARY KEY (project_id, event_id, ref_order)
);

CREATE TABLE IF NOT EXISTS artifacts (
  project_id TEXT NOT NULL,
  artifact_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  stale INTEGER NOT NULL,
  superseded_by TEXT,
  algorithm TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  parameters TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  payload TEXT NOT NULL,
  diagnostic TEXT,
  created_at INTEGER NOT NULL,
  created_seq INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id, created_seq);

CREATE TABLE IF NOT EXISTS artifact_sources (
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  ref_order INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  version INTEGER,
  sha256 TEXT NOT NULL,
  summary TEXT NOT NULL,
  PRIMARY KEY (project_id, artifact_id, ref_order)
);

CREATE TABLE IF NOT EXISTS candidates (
  project_id TEXT NOT NULL,
  candidate_id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  target_type TEXT NOT NULL,
  offset_cycles INTEGER NOT NULL,
  status TEXT NOT NULL,
  tree_path TEXT NOT NULL,
  cycle_residuals TEXT NOT NULL,
  reject_reason TEXT,
  created_at INTEGER NOT NULL,
  created_seq INTEGER NOT NULL,
  sources TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locks (
  project_id TEXT NOT NULL,
  lock_id TEXT PRIMARY KEY,
  region_id TEXT NOT NULL,
  candidate_id TEXT,
  locked_offset_cycles INTEGER,
  decision TEXT NOT NULL,
  adjustments TEXT NOT NULL,
  note TEXT NOT NULL,
  actor TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  undone_at INTEGER,
  resolves_conflict_id TEXT,
  sources TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conflicts (
  project_id TEXT NOT NULL,
  conflict_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  description TEXT NOT NULL,
  involved_candidates TEXT NOT NULL,
  involved_locks TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution_event_id TEXT
);

-- Counterexample archive
CREATE TABLE IF NOT EXISTS archive_inputs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  scenario TEXT NOT NULL,
  role TEXT NOT NULL,
  interpretation_version INTEGER NOT NULL,
  interpretation_note TEXT NOT NULL,
  diagnostic TEXT,
  adopted INTEGER NOT NULL,
  accepted INTEGER NOT NULL,
  decision_note TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  order_index INTEGER NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS archive_fragments (
  project_id TEXT NOT NULL,
  archive_id TEXT NOT NULL,
  ref_order INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (project_id, archive_id, ref_order)
);

CREATE TABLE IF NOT EXISTS archive_judgments (
  project_id TEXT NOT NULL,
  archive_id TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  criterion TEXT NOT NULL,
  passed INTEGER NOT NULL,
  detail TEXT NOT NULL,
  affected TEXT NOT NULL,
  expected TEXT NOT NULL,
  scenario TEXT NOT NULL,
  PRIMARY KEY (project_id, archive_id, order_index)
);
`;
