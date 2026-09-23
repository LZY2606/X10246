import { DatabaseSync } from "node:sqlite";

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 原始内容：内容寻址，只存一份，不可变
CREATE TABLE IF NOT EXISTS raw_content (
  digest TEXT PRIMARY KEY,
  payload TEXT NOT NULL
);

-- 输入实体（逻辑身份）
CREATE TABLE IF NOT EXISTS input_entity (
  entity_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 输入版本：不可覆盖，修订以新版本+父版本表达
CREATE TABLE IF NOT EXISTS input_version (
  version_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES input_entity(entity_id),
  parent_version_id TEXT,
  digest TEXT NOT NULL REFERENCES raw_content(digest),
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- 派生结果（候选、高度图、诊断等），带算法版本、参数指纹与直接来源
CREATE TABLE IF NOT EXISTS derived_result (
  result_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  params_fingerprint TEXT NOT NULL,
  digest TEXT NOT NULL REFERENCES raw_content(digest),
  status TEXT NOT NULL,            -- current | stale | superseded
  stale_reason TEXT,
  created_at TEXT NOT NULL
);

-- 派生结果的直接来源（实体+版本+摘要）
CREATE TABLE IF NOT EXISTS result_source (
  result_id TEXT NOT NULL REFERENCES derived_result(result_id),
  entity_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  PRIMARY KEY (result_id, entity_id, version_id)
);

-- 人工决定（接受/否定/锁定/解锁/撤销/参数调整），全部入历史
CREATE TABLE IF NOT EXISTS decision (
  decision_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  rationale TEXT,
  undone_by TEXT,
  created_at TEXT NOT NULL
);

-- 机器可读事件日志（判断依据、影响范围、冲突等）
CREATE TABLE IF NOT EXISTS event_log (
  event_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);
  return db;
}
