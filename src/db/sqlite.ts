/**
 * SQLite 适配层。
 * 默认使用 Node 内置 `node:sqlite`（真实 SQLite 文件数据库，无原生编译依赖）。
 * 接口刻意做成 better-sqlite3 风格的最小子集，便于替换实现。
 */
import { DatabaseSync } from 'node:sqlite';

export interface DBStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

export interface DB {
  exec(sql: string): void;
  prepare(sql: string): DBStatement;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function openDatabase(path: string): DB {
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA foreign_keys = ON;');
  const wrap = (stmt: ReturnType<DatabaseSync['prepare']>): DBStatement => ({
    get: (...p) => stmt.get(...(p as never[])) as unknown,
    all: (...p) => stmt.all(...(p as never[])) as unknown[],
    run: (...p) =>
      stmt.run(...(p as never[])) as {
        changes: number | bigint;
        lastInsertRowid: number | bigint;
      },
  });
  const db: DB = {
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => wrap(raw.prepare(sql)),
    transaction<T>(fn: () => T): T {
      raw.exec('BEGIN');
      try {
        const result = fn();
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
    close: () => raw.close(),
  };
  return db;
}
