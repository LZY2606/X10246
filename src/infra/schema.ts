export const SCHEMA_SQL = `
PRAGMA user_version = 3;

CREATE TABLE IF NOT EXISTS projects (
  project_id      TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  created_tick    INTEGER NOT NULL,
  params_json     TEXT NOT NULL
);

-- 不可变原始片段：最小输入与组合输入共享片段时只存一份。
CREATE TABLE IF NOT EXISTS raw_fragments (
  project_id      TEXT NOT NULL,
  fragment_id     TEXT NOT NULL,
  content_digest  TEXT NOT NULL,
  raw_repr        TEXT NOT NULL,
  media_type      TEXT NOT NULL,
  byte_length     INTEGER NOT NULL,
  PRIMARY KEY (project_id, fragment_id)
);

-- 七类输入实体的不可变版本。
CREATE TABLE IF NOT EXISTS versions (
  project_id        TEXT NOT NULL,
  version_id        TEXT NOT NULL,
  entity_id         TEXT NOT NULL,
  kind              TEXT NOT NULL,
  parent_version_id TEXT,
  version_no        INTEGER NOT NULL,
  created_tick      INTEGER NOT NULL,
  created_by        TEXT NOT NULL,
  unit              TEXT,
  datum             TEXT,
  raw_repr          TEXT NOT NULL,
  payload_json      TEXT NOT NULL,
  content_digest    TEXT NOT NULL,
  revision_note     TEXT NOT NULL,
  PRIMARY KEY (project_id, version_id),
  UNIQUE (project_id, entity_id, version_no)
);

-- 仅追加事件账本（人工决定、冲突、撤销、回滚都落库）。
CREATE TABLE IF NOT EXISTS events (
  project_id     TEXT NOT NULL,
  event_id       TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  tick           INTEGER NOT NULL,
  actor          TEXT NOT NULL,
  action         TEXT NOT NULL,
  refs_json      TEXT NOT NULL,
  params_fp      TEXT,
  payload_json   TEXT NOT NULL,
  machine_json   TEXT NOT NULL,
  parent_event_id TEXT,
  PRIMARY KEY (project_id, event_id),
  UNIQUE (project_id, seq)
);

-- 派生相位展开结果（可随源过期，但记录保留可查）。
CREATE TABLE IF NOT EXISTS unwrap_results (
  project_id     TEXT NOT NULL,
  result_id      TEXT NOT NULL,
  tree_id        TEXT NOT NULL,
  algorithm_ver  TEXT NOT NULL,
  params_fp      TEXT NOT NULL,
  sources_json   TEXT NOT NULL,
  grid_json      TEXT NOT NULL,
  edges_json     TEXT NOT NULL,
  plaquettes_json TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  cycles_json    TEXT NOT NULL,
  unresolved_json TEXT NOT NULL,
  status         TEXT NOT NULL,
  created_event_id TEXT NOT NULL,
  PRIMARY KEY (project_id, result_id)
);

CREATE TABLE IF NOT EXISTS height_results (
  project_id     TEXT NOT NULL,
  result_id      TEXT NOT NULL,
  unwrap_result_id TEXT NOT NULL,
  wavelength_version_id TEXT NOT NULL,
  geometry_version_id TEXT NOT NULL,
  calibration_version_id TEXT NOT NULL,
  algorithm_ver  TEXT NOT NULL,
  params_fp      TEXT NOT NULL,
  chain_json     TEXT NOT NULL,
  grid_json      TEXT NOT NULL,
  status         TEXT NOT NULL,
  created_event_id TEXT NOT NULL,
  PRIMARY KEY (project_id, result_id)
);

CREATE TABLE IF NOT EXISTS locks (
  project_id  TEXT NOT NULL,
  lock_id     TEXT NOT NULL,
  pixel_r     INTEGER NOT NULL,
  pixel_c     INTEGER NOT NULL,
  wrap_count  INTEGER NOT NULL,
  source_result_id TEXT NOT NULL,
  owner       TEXT NOT NULL,
  created_tick INTEGER NOT NULL,
  active      INTEGER NOT NULL,
  conflict    INTEGER NOT NULL,
  PRIMARY KEY (project_id, lock_id)
);

-- 反例档案：最小/组合输入共享片段，解释与人工决定独立。
CREATE TABLE IF NOT EXISTS adversary_cases (
  project_id  TEXT NOT NULL,
  scenario    TEXT NOT NULL,
  case_json   TEXT NOT NULL,
  PRIMARY KEY (project_id, scenario)
);

CREATE INDEX IF NOT EXISTS idx_versions_entity ON versions(project_id, entity_id, version_no);
CREATE INDEX IF NOT EXISTS idx_events_seq ON events(project_id, seq);
`;
