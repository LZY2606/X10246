import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    clock TEXT NOT NULL DEFAULT 'virtual',
    case_pack_id TEXT
  );

  CREATE TABLE IF NOT EXISTS contents (
    content_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    raw_json TEXT,
    diagnostics_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS object_versions (
    object_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    kind TEXT NOT NULL,
    content_id TEXT NOT NULL,
    parent_event_id TEXT,
    algorithm_version TEXT,
    parameter_fingerprint TEXT,
    sources_json TEXT NOT NULL DEFAULT '[]',
    scope_regions_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by_event TEXT NOT NULL,
    summary TEXT NOT NULL,
    PRIMARY KEY (object_id, version)
  );

  CREATE TABLE IF NOT EXISTS locks (
    region_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    tree_id TEXT,
    locked_at TEXT NOT NULL,
    locked_by_event TEXT NOT NULL,
    note TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (region_id, candidate_id)
  );

  CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL UNIQUE,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,
    scenario TEXT,
    object_id TEXT,
    version INTEGER,
    parent_event_id TEXT,
    sources_json TEXT,
    payload_json TEXT,
    rationale_json TEXT,
    undone INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS object_keys (
    logical_key TEXT PRIMARY KEY,
    object_id TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS kv (
    project_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    PRIMARY KEY (project_id, key)
  );
  `);
}

export type DB = ReturnType<typeof openDatabase>;
