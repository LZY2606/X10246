/** 事件溯源 + 内容寻址存储的 SQLite 结构。 */
export const SCHEMA_VERSION = 'ledger-1.0.0';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  scenario_tags TEXT NOT NULL
);

-- 不可变内容（共享原始片段只存一份）
CREATE TABLE IF NOT EXISTS contents (
  content_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  canonical TEXT NOT NULL,
  bytes INTEGER NOT NULL
);

-- 只追加事件（顺序由 seq 决定，身份含父事件与内容哈希）
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  parent_event_id TEXT,
  at TEXT NOT NULL,
  content_id TEXT NOT NULL,
  refs TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  parent_version_event_id TEXT,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE(project_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(project_id, entity_type, entity_key, version);
CREATE INDEX IF NOT EXISTS idx_events_content ON events(content_id);

-- 帧瓦片内容单独建表去重（物理上保证共享片段只存一份）
CREATE TABLE IF NOT EXISTS tiles (
  content_id TEXT PRIMARY KEY,
  canonical TEXT NOT NULL,
  bytes INTEGER NOT NULL
);
`;

export interface SchemaMeta {
  schemaVersion: string;
  createdAt: string;
}
