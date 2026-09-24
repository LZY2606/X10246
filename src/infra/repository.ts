import type { Database } from "sql.js";
import { SCHEMA_SQL } from "./schema";
import { getSql } from "./driver";
import type {
  AdversaryCase,
  HeightChainResult,
  IntegrityDiagnostic,
  LedgerEvent,
  LocalLock,
  RawFragment,
  UnwrapTreeResult,
  VersionEntity,
} from "../domain/types";

export interface ProjectMeta {
  projectId: string;
  name: string;
  createdTick: number;
  paramsJson: string;
}

export class Repository {
  private constructor(public db: Database) {}

  static async create(): Promise<Repository> {
    const SQL = await getSql();
    const db = new SQL.Database();
    db.run(SCHEMA_SQL);
    return new Repository(db);
  }

  static async fromBytes(bytes: Uint8Array): Promise<Repository> {
    const SQL = await getSql();
    const db = new SQL.Database(bytes);
    const row = db.exec("PRAGMA user_version");
    const ver = row.length ? row[0].values[0][0] : 0;
    if (Number(ver) < 3) {
      db.close();
      throw new Error("IMPORT_FORMAT_ERROR: 数据库 user_version 过低，不是本系统导出的库");
    }
    return new Repository(db);
  }

  exportBytes(): Uint8Array {
    return this.db.export();
  }

  close(): void {
    this.db.close();
  }

  createProject(meta: ProjectMeta): void {
    this.db.run(
      "INSERT INTO projects(project_id,name,created_tick,params_json) VALUES (?,?,?,?)",
      [meta.projectId, meta.name, meta.createdTick, meta.paramsJson]
    );
  }

  getProject(projectId: string): ProjectMeta | null {
    const stmt = this.db.prepare("SELECT * FROM projects WHERE project_id=?");
    stmt.bind([projectId]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    return {
      projectId: String(row.project_id),
      name: String(row.name),
      createdTick: Number(row.created_tick),
      paramsJson: String(row.params_json),
    };
  }

  listProjects(): ProjectMeta[] {
    const res = this.db.exec("SELECT project_id,name,created_tick,params_json FROM projects ORDER BY created_tick");
    if (!res.length) return [];
    return res[0].values.map((v) => ({
      projectId: String(v[0]),
      name: String(v[1]),
      createdTick: Number(v[2]),
      paramsJson: String(v[3]),
    }));
  }
}
