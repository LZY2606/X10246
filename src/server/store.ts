/**
 * 单进程共享的 SQLite 账本（演示/开发用）。
 * 数据文件放在 .data/ledger.sqlite（被 .gitignore 忽略），不依赖开发者机器上的数据库。
 * 可通过 LEDGER_DB 覆盖到临时目录（测试用）。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Ledger } from '../db/ledger.ts';
import { buildDemoProject, buildCounterexampleArchive } from '../service/demo.ts';

let singleton: Ledger | null = null;
let dbPath = process.env.LEDGER_DB || '.data/ledger.sqlite';

export function setDbPath(path: string): void {
  if (singleton) singleton.close();
  singleton = null;
  dbPath = path;
}

export function getLedger(): Ledger {
  if (!singleton) {
    mkdirSync(dirname(dbPath), { recursive: true });
    singleton = new Ledger(dbPath);
    buildDemoProject(singleton);
    buildCounterexampleArchive(singleton);
  }
  return singleton;
}

export function currentDbPath(): string {
  return dbPath;
}
