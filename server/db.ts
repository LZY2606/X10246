import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS inputs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      version INTEGER NOT NULL,
      parent_id TEXT,
      digest TEXT NOT NULL,
      payload TEXT NOT NULL,
      submitted_at INTEGER NOT NULL,
      author TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS computations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      algorithm_version TEXT NOT NULL,
      param_fingerprint TEXT NOT NULL,
      source_refs TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      digest TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS locks (
      id TEXT PRIMARY KEY,
      region TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      basis TEXT NOT NULL,
      active INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL UNIQUE,
      type TEXT NOT NULL,
      at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}
