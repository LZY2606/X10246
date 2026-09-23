import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_packs (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      fixed_seed INTEGER NOT NULL,
      generated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      content_digest TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scenario TEXT NOT NULL,
      case_pack_id TEXT NOT NULL,
      case_pack_version TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      current_run_id TEXT
    );
    CREATE TABLE IF NOT EXISTS fragments (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      role TEXT,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      unit TEXT,
      coordinate_basis TEXT,
      original_representation TEXT NOT NULL,
      data_json TEXT NOT NULL,
      sha256 TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS input_versions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      version INTEGER NOT NULL,
      parent_version_id TEXT,
      fragment_ids_json TEXT NOT NULL,
      digest TEXT NOT NULL,
      source_label TEXT NOT NULL,
      scope TEXT NOT NULL,
      affected_region_json TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(project_id, kind, version),
      FOREIGN KEY(project_id) REFERENCES projects(id)
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      algorithm_version TEXT NOT NULL,
      parameter_fingerprint TEXT NOT NULL,
      seed INTEGER NOT NULL,
      status TEXT NOT NULL,
      stale_reference TEXT,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE(project_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS locks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      pixel_id TEXT NOT NULL,
      tree_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      conflict_with_json TEXT NOT NULL,
      note TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stale_entities (
      entity_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      reason TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(entity_id, event_id)
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      references_json TEXT NOT NULL,
      parent_event_id TEXT,
      UNIQUE(project_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS archive_meta (
      archive_id TEXT PRIMARY KEY,
      exported_at INTEGER NOT NULL,
      event_count INTEGER NOT NULL,
      content_digest TEXT NOT NULL
    );
  `);
  return db;
}

export type SqliteDatabase = DatabaseSync;
