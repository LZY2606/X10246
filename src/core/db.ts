import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 1;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- 内容寻址的不可变原始片段：共享片段只存一份
    CREATE TABLE IF NOT EXISTS blobs (
      digest TEXT PRIMARY KEY,
      content TEXT NOT NULL
    );
    -- 输入实体（身份稳定，本身不可变）
    CREATE TABLE IF NOT EXISTS input_entities (
      entity_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    -- 输入版本：不可覆盖，修订以新版本 + 父版本表达
    CREATE TABLE IF NOT EXISTS input_versions (
      entity_id TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      parent_version_no INTEGER,
      blob_digest TEXT NOT NULL REFERENCES blobs(digest),
      digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      note TEXT,
      PRIMARY KEY (entity_id, version_no)
    );
    -- 派生结果：带算法版本、参数指纹与直接来源；过期仍可查看但不冒充当前
    CREATE TABLE IF NOT EXISTS derived_results (
      result_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      algorithm_version TEXT NOT NULL,
      param_fingerprint TEXT NOT NULL,
      sources TEXT NOT NULL,
      payload TEXT NOT NULL,
      digest TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    -- 事件日志：机器可读，顺序即历史；导出导入保持顺序
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL,
      type TEXT NOT NULL,
      at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');
  `);
  return db;
}
