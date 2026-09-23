import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Clock = () => string;

export const SYSTEM_CLOCK: Clock = () => new Date().toISOString();

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- 原始输入：内容寻址、不可覆盖；原始表示原样保留，规范化在派生层
  CREATE TABLE IF NOT EXISTS raw_inputs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    normalized_json TEXT,
    diagnostics_json TEXT NOT NULL DEFAULT '[]',
    unit TEXT,
    frame TEXT,
    created_seq INTEGER NOT NULL,
    UNIQUE(kind, content_hash)
  );
  -- 逻辑数据流（如"本装置的波长"），修订以新版本+父版本表达
  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    created_seq INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS source_versions (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id),
    version_no INTEGER NOT NULL,
    parent_version_id TEXT REFERENCES source_versions(id),
    raw_input_id TEXT NOT NULL REFERENCES raw_inputs(id),
    note TEXT,
    created_seq INTEGER NOT NULL,
    UNIQUE(source_id, version_no)
  );
  -- 解释版本（一次展开/标定计算），带算法版本与参数指纹
  CREATE TABLE IF NOT EXISTS interpretations (
    id TEXT PRIMARY KEY,
    algo_version TEXT NOT NULL,
    param_fingerprint TEXT NOT NULL,
    params_json TEXT NOT NULL,
    status TEXT NOT NULL,           -- current | stale | superseded
    stale_reason TEXT,
    created_seq INTEGER NOT NULL
  );
  -- 直接来源：解释版本 -> 输入版本（缺引用必须报损坏）
  CREATE TABLE IF NOT EXISTS interpretation_sources (
    interpretation_id TEXT NOT NULL REFERENCES interpretations(id),
    role TEXT NOT NULL,
    source_version_id TEXT NOT NULL REFERENCES source_versions(id),
    content_hash TEXT NOT NULL,
    PRIMARY KEY (interpretation_id, role)
  );
  -- 候选：整周偏移候选 / 展开树 / 高度图；采纳与未采纳都保留
  CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY,
    interpretation_id TEXT NOT NULL REFERENCES interpretations(id),
    kind TEXT NOT NULL,             -- unwrap_tree | integer_offset | height_map
    region_id TEXT,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL,            -- proposed | accepted | rejected | unknown
    reject_reason TEXT,
    created_seq INTEGER NOT NULL
  );
  -- 人工决定：接受/否定/参数调整/锁定/冲突解决/撤销，全部进历史
  CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    undone_by TEXT,
    created_seq INTEGER NOT NULL
  );
  -- 局部锁定
  CREATE TABLE IF NOT EXISTS locks (
    id TEXT PRIMARY KEY,
    region_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL REFERENCES candidates(id),
    status TEXT NOT NULL,           -- active | conflict | released
    conflict_with TEXT,
    created_seq INTEGER NOT NULL
  );
  -- 追加式事件日志（含机器可读取的判断依据）
  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    entity_kind TEXT,
    entity_id TEXT,
    judgment_json TEXT,
    payload_json TEXT NOT NULL
  );
  -- 反例档案：基线 + 单源改动变体
  CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY,
    scenario TEXT NOT NULL,
    title TEXT NOT NULL,
    baseline_json TEXT NOT NULL,
    variant_json TEXT NOT NULL,
    created_seq INTEGER NOT NULL
  );
  `);
}

export function nextId(db: DatabaseSync, prefix: string): string {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(`seq_${prefix}`) as { value: string } | undefined;
  const n = row ? Number(row.value) + 1 : 1;
  db.prepare(`INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(`seq_${prefix}`, String(n));
  return `${prefix}_${n}`;
}

export function currentSeq(db: DatabaseSync): number {
  const row = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS s FROM events`).get() as { s: number };
  return row.s;
}
