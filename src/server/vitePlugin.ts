/** Vite 中间件：单条 npm run dev 同时提供页面与 API，SQLite 持久化在 ./data/review.db。 */
import type { Plugin } from "vite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../core/db";
import { Store } from "../core/store";
import { ReviewEngine } from "../core/engine";
import { handleApi } from "../core/api";
import { systemClock } from "../domain/clock";

export function reviewApiPlugin(dbPath?: string): Plugin {
  const dataDir = join(process.cwd(), "data");
  const file = dbPath ?? join(dataDir, "review.db");
  mkdirSync(dataDir, { recursive: true });
  let db: DatabaseSync;
  let store: Store;
  let engine: ReviewEngine;
  const open = () => {
    db = openDatabase(file);
    store = new Store(db, systemClock);
    engine = new ReviewEngine(store, systemClock);
  };
  open();
  const ctx = {
    get db() { return db; },
    get store() { return store; },
    get engine() { return engine; },
    samplesDir: join(process.cwd(), "samples"),
    resetDb: () => {
      db.close();
      rmSync(file, { force: true });
      rmSync(file + "-wal", { force: true });
      rmSync(file + "-shm", { force: true });
      open();
    },
  };
  return {
    name: "interferometry-review-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith("/api/")) {
          void handleApi(ctx as never, req, res);
          return;
        }
        next();
      });
    },
  };
}
