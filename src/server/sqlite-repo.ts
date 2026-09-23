/**
 * SQLite 持久化（Node 内置 node:sqlite）。
 * - fragments: 内容寻址片段，原始大数组只存一份；
 * - records:   实体版本流（原始输入不可覆盖，修订是新版本+父版本）；
 * - events:    只追加事件哈希链；
 * - kv:        项目元数据 / 虚拟时钟。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJSON } from "../core/canonical";
import { contentId, sha256Hex } from "../core/ids";
import type { EntityRecord, EntityKind, GridFragment, RecordRef, ReviewEvent } from "../core/types";

export interface StoredProject {
  projectId: string;
  title: string;
  seed: number;
  scenarioIds: string[];
  clock: number;
  baseIso: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  seed INTEGER NOT NULL,
  scenario_ids TEXT NOT NULL,
  clock INTEGER NOT NULL,
  base_iso TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fragments (
  project_id TEXT NOT NULL,
  fragment_id TEXT NOT NULL,
  encoding TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  digest TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (project_id, fragment_id)
);
CREATE TABLE IF NOT EXISTS records (
  project_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  digest TEXT NOT NULL,
  parent_json TEXT,
  status TEXT NOT NULL,
  committed_at INTEGER NOT NULL,
  provenance_json TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (project_id, stream_id, version)
);
CREATE TABLE IF NOT EXISTS events (
  project_id TEXT NOT NULL,
  event_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  parent_event_id TEXT,
  at_virtual_iso TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  refs_json TEXT NOT NULL,
  affected_json TEXT NOT NULL,
  judgment_json TEXT,
  body_json TEXT NOT NULL
);
`;

export class SqliteProjectRepository {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  createProject(p: StoredProject): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO projects(project_id,title,seed,scenario_ids,clock,base_iso)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(p.projectId, p.title, p.seed, JSON.stringify(p.scenarioIds), p.clock, p.baseIso);
  }

  getProject(projectId: string): StoredProject | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE project_id=?").get(projectId) as
      | { project_id: string; title: string; seed: number; scenario_ids: string; clock: number; base_iso: string }
      | undefined;
    if (!row) return null;
    return {
      projectId: row.project_id,
      title: row.title,
      seed: row.seed,
      scenarioIds: JSON.parse(row.scenario_ids) as string[],
      clock: row.clock,
      baseIso: row.base_iso,
    };
  }

  listProjects(): StoredProject[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY project_id").all() as Array<{
      project_id: string;
      title: string;
      seed: number;
      scenario_ids: string;
      clock: number;
      base_iso: string;
    }>;
    return rows.map((row) => ({
      projectId: row.project_id,
      title: row.title,
      seed: row.seed,
      scenarioIds: JSON.parse(row.scenario_ids) as string[],
      clock: row.clock,
      baseIso: row.base_iso,
    }));
  }

  setClock(projectId: string, clock: number) {
    this.db.prepare("UPDATE projects SET clock=? WHERE project_id=?").run(clock, projectId);
  }

  putFragment(projectId: string, f: GridFragment): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO fragments(project_id,fragment_id,encoding,width,height,digest,data)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(projectId, f.fragmentId, f.encoding, f.width, f.height, f.digest, canonicalJSON(f.data));
  }

  getFragment(projectId: string, fragmentId: string): GridFragment | null {
    const row = this.db
      .prepare("SELECT * FROM fragments WHERE project_id=? AND fragment_id=?")
      .get(projectId, fragmentId) as
      | { fragment_id: string; encoding: GridFragment["encoding"]; width: number; height: number; digest: string; data: string }
      | undefined;
    if (!row) return null;
    return {
      kind: "gridFragment",
      fragmentId: row.fragment_id,
      encoding: row.encoding,
      width: row.width,
      height: row.height,
      digest: row.digest,
      data: JSON.parse(row.data) as number[] | string,
    };
  }

  listFragments(projectId: string): GridFragment[] {
    const rows = this.db.prepare("SELECT * FROM fragments WHERE project_id=? ORDER BY fragment_id").all(projectId) as Array<{
      fragment_id: string;
      encoding: GridFragment["encoding"];
      width: number;
      height: number;
      digest: string;
      data: string;
    }>;
    return rows.map((row) => ({
      kind: "gridFragment" as const,
      fragmentId: row.fragment_id,
      encoding: row.encoding,
      width: row.width,
      height: row.height,
      digest: row.digest,
      data: JSON.parse(row.data) as number[] | string,
    }));
  }

  putRecord<T>(projectId: string, rec: EntityRecord<T>): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO records(project_id,stream_id,version,kind,digest,parent_json,status,committed_at,provenance_json,payload_json)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        projectId,
        rec.streamId,
        rec.version,
        rec.kind,
        rec.digest,
        rec.parentRef ? canonicalJSON(rec.parentRef) : null,
        rec.status,
        rec.committedAt,
        rec.provenance ? canonicalJSON(rec.provenance) : null,
        canonicalJSON(rec.payload),
      );
  }

  getRecord<T = unknown>(projectId: string, streamId: string, version: number): EntityRecord<T> | null {
    const row = this.db
      .prepare("SELECT * FROM records WHERE project_id=? AND stream_id=? AND version=?")
      .get(projectId, streamId, version) as RecordRow | undefined;
    return row ? rowToRecord<T>(row) : null;
  }

  latestVersion(projectId: string, streamId: string): number | null {
    const row = this.db
      .prepare("SELECT MAX(version) AS v FROM records WHERE project_id=? AND stream_id=?")
      .get(projectId, streamId) as { v: number | null } | undefined;
    return row?.v ?? null;
  }

  listStream<T = unknown>(projectId: string, streamId: string): EntityRecord<T>[] {
    const rows = this.db
      .prepare("SELECT * FROM records WHERE project_id=? AND stream_id=? ORDER BY version")
      .all(projectId, streamId) as RecordRow[];
    return rows.map(rowToRecord<T>);
  }

  listRecords<T = unknown>(projectId: string): EntityRecord<T>[] {
    const rows = this.db
      .prepare("SELECT * FROM records WHERE project_id=? ORDER BY stream_id, version")
      .all(projectId) as RecordRow[];
    return rows.map(rowToRecord<T>);
  }

  setStatus(projectId: string, streamId: string, version: number, status: EntityRecord["status"]) {
    this.db
      .prepare("UPDATE records SET status=? WHERE project_id=? AND stream_id=? AND version=?")
      .run(status, projectId, streamId, version);
  }

  appendEvent(projectId: string, ev: ReviewEvent): void {
    this.db
      .prepare(
        `INSERT INTO events(project_id,event_id,seq,parent_event_id,at_virtual_iso,type,summary,refs_json,affected_json,judgment_json,body_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        projectId,
        ev.eventId,
        ev.seq,
        ev.parentEventId,
        ev.atVirtualIso,
        ev.type,
        ev.summary,
        canonicalJSON(ev.refs),
        canonicalJSON(ev.affectedObjects),
        ev.judgment ? canonicalJSON(ev.judgment) : null,
        canonicalJSON(ev.body),
      );
  }

  listEvents(projectId: string): ReviewEvent[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE project_id=? ORDER BY seq").all(projectId) as EventRow[];
    return rows.map((row) => ({
      eventId: row.event_id,
      seq: row.seq,
      parentEventId: row.parent_event_id,
      atVirtualIso: row.at_virtual_iso,
      type: row.type as ReviewEvent["type"],
      summary: row.summary,
      refs: JSON.parse(row.refs_json) as RecordRef[],
      affectedObjects: JSON.parse(row.affected_json) as string[],
      judgment: row.judgment_json ? (JSON.parse(row.judgment_json) as ReviewEvent["judgment"]) : null,
      body: JSON.parse(row.body_json) as Record<string, unknown>,
    }));
  }

  deleteProject(projectId: string): void {
    for (const table of ["events", "records", "fragments", "projects"]) {
      this.db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(projectId);
    }
  }
}

interface RecordRow {
  stream_id: string;
  version: number;
  kind: EntityKind;
  digest: string;
  parent_json: string | null;
  status: EntityRecord["status"];
  committed_at: number;
  provenance_json: string | null;
  payload_json: string;
}

interface EventRow {
  event_id: string;
  seq: number;
  parent_event_id: string | null;
  at_virtual_iso: string;
  type: ReviewEvent["type"];
  summary: string;
  refs_json: string;
  affected_json: string;
  judgment_json: string | null;
  body_json: string;
}

function rowToRecord<T>(row: RecordRow): EntityRecord<T> {
  return {
    streamId: row.stream_id,
    version: row.version,
    kind: row.kind,
    digest: row.digest,
    parentRef: row.parent_json ? (JSON.parse(row.parent_json) as RecordRef) : null,
    status: row.status,
    committedAt: row.committed_at,
    provenance: row.provenance_json ? (JSON.parse(row.provenance_json) as EntityRecord["provenance"]) : null,
    payload: JSON.parse(row.payload_json) as T,
  };
}

export function digestPayload(kind: EntityKind, payload: unknown): string {
  return contentId("rec", { kind, payload }).replace(/^rec_/, "dig_");
}

export function recomputeDigest(kind: EntityKind, payload: unknown): string {
  return `dig_${sha256Hex(canonicalJSON({ kind, payload })).slice(0, 32)}`;
}
