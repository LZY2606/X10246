import { DatabaseSync } from 'node:sqlite';
import type {
  Archive,
  Bundle,
  DomainEvent,
  Interpretation,
  RawInputEnvelope,
  Ref,
} from '../shared/types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fragments (
  digest TEXT PRIMARY KEY,
  content TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS raw_inputs (
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  parent TEXT,
  digest TEXT NOT NULL,
  content TEXT NOT NULL,
  provenance TEXT NOT NULL,
  logical_time REAL NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE TABLE IF NOT EXISTS interpretations (
  id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  param_fingerprint TEXT NOT NULL,
  sources TEXT NOT NULL,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  diagnostics TEXT NOT NULL,
  logical_time REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS bundles (
  id TEXT PRIMARY KEY,
  members TEXT NOT NULL,
  logical_time REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  refs TEXT NOT NULL,
  payload TEXT NOT NULL,
  logical_time REAL NOT NULL
);
`;

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  clear(): void {
    this.db.exec(
      'DELETE FROM fragments; DELETE FROM raw_inputs; DELETE FROM interpretations; DELETE FROM bundles; DELETE FROM events;',
    );
  }

  /* ---------- fragments（共享原始片段，只存一份，不可变） ---------- */

  putFragment(digest: string, content: unknown): void {
    this.db
      .prepare('INSERT OR IGNORE INTO fragments (digest, content) VALUES (?, ?)')
      .run(digest, JSON.stringify(content));
  }

  getFragment(digest: string): unknown | null {
    const row = this.db.prepare('SELECT content FROM fragments WHERE digest = ?').get(digest) as
      | { content: string }
      | undefined;
    return row ? JSON.parse(row.content) : null;
  }

  /* ---------- raw inputs（不可覆盖） ---------- */

  putRaw(e: RawInputEnvelope): void {
    this.db
      .prepare(
        'INSERT INTO raw_inputs (id, kind, version, parent, digest, content, provenance, logical_time) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        e.id,
        e.kind,
        e.version,
        e.parent,
        e.digest,
        JSON.stringify(e.content),
        JSON.stringify(e.provenance),
        e.logicalTime,
      );
  }

  getRaw(id: string, version?: number): RawInputEnvelope | null {
    const row =
      version === undefined
        ? (this.db
            .prepare('SELECT * FROM raw_inputs WHERE id = ? ORDER BY version DESC LIMIT 1')
            .get(id) as Record<string, unknown> | undefined)
        : (this.db
            .prepare('SELECT * FROM raw_inputs WHERE id = ? AND version = ?')
            .get(id, version) as Record<string, unknown> | undefined);
    return row ? this.rowToRaw(row) : null;
  }

  listRaw(): RawInputEnvelope[] {
    const rows = this.db
      .prepare('SELECT * FROM raw_inputs ORDER BY id, version')
      .all() as unknown as Record<string, unknown>[];
    return rows.map((r) => this.rowToRaw(r));
  }

  private rowToRaw(row: Record<string, unknown>): RawInputEnvelope {
    return {
      id: row.id as string,
      kind: row.kind as RawInputEnvelope['kind'],
      version: row.version as number,
      parent: (row.parent as string | null) ?? null,
      digest: row.digest as string,
      content: JSON.parse(row.content as string),
      provenance: JSON.parse(row.provenance as string),
      logicalTime: row.logical_time as number,
    };
  }

  /* ---------- interpretations ---------- */

  putInterpretation(i: Interpretation): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO interpretations (id, bundle_id, kind, algorithm_version, param_fingerprint, sources, status, payload, diagnostics, logical_time) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        i.id,
        i.bundleId,
        i.kind,
        i.algorithmVersion,
        i.paramFingerprint,
        JSON.stringify(i.sources),
        i.status,
        JSON.stringify(i.payload),
        JSON.stringify(i.diagnostics),
        i.logicalTime,
      );
  }

  getInterpretation(id: string): Interpretation | null {
    const row = this.db.prepare('SELECT * FROM interpretations WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToInterp(row) : null;
  }

  listInterpretations(bundleId?: string): Interpretation[] {
    const rows = (
      bundleId
        ? this.db
            .prepare('SELECT * FROM interpretations WHERE bundle_id = ? ORDER BY logical_time, id')
            .all(bundleId)
        : this.db.prepare('SELECT * FROM interpretations ORDER BY logical_time, id').all()
    ) as unknown as Record<string, unknown>[];
    return rows.map((r) => this.rowToInterp(r));
  }

  setInterpretationStatus(id: string, status: string): void {
    this.db.prepare('UPDATE interpretations SET status = ? WHERE id = ?').run(status, id);
  }

  private rowToInterp(row: Record<string, unknown>): Interpretation {
    return {
      id: row.id as string,
      bundleId: row.bundle_id as string,
      kind: row.kind as Interpretation['kind'],
      algorithmVersion: row.algorithm_version as string,
      paramFingerprint: row.param_fingerprint as string,
      sources: JSON.parse(row.sources as string) as Ref[],
      status: row.status as Interpretation['status'],
      payload: JSON.parse(row.payload as string),
      diagnostics: JSON.parse(row.diagnostics as string),
      logicalTime: row.logical_time as number,
    };
  }

  /* ---------- bundles ---------- */

  putBundle(b: Bundle): void {
    this.db
      .prepare('INSERT OR REPLACE INTO bundles (id, members, logical_time) VALUES (?,?,?)')
      .run(b.id, JSON.stringify(b.members), b.logicalTime);
  }

  getBundle(id: string): Bundle | null {
    const row = this.db.prepare('SELECT * FROM bundles WHERE id = ?').get(id) as
      | { id: string; members: string; logical_time: number }
      | undefined;
    return row
      ? { id: row.id, members: JSON.parse(row.members), logicalTime: row.logical_time }
      : null;
  }

  listBundles(): Bundle[] {
    const rows = this.db.prepare('SELECT * FROM bundles ORDER BY logical_time, id').all() as unknown as {
      id: string;
      members: string;
      logical_time: number;
    }[];
    return rows.map((r) => ({ id: r.id, members: JSON.parse(r.members), logicalTime: r.logical_time }));
  }

  /* ---------- events（只追加） ---------- */

  appendEvent(e: DomainEvent): void {
    this.db
      .prepare('INSERT INTO events (seq, id, type, refs, payload, logical_time) VALUES (?,?,?,?,?,?)')
      .run(e.seq, e.id, e.type, JSON.stringify(e.refs), JSON.stringify(e.payload), e.logicalTime);
  }

  listEvents(): DomainEvent[] {
    const rows = this.db.prepare('SELECT * FROM events ORDER BY seq').all() as unknown as Record<
      string,
      unknown
    >[];
    return rows.map((r) => ({
      seq: r.seq as number,
      id: r.id as string,
      type: r.type as DomainEvent['type'],
      refs: JSON.parse(r.refs as string),
      payload: JSON.parse(r.payload as string),
      logicalTime: r.logical_time as number,
    }));
  }

  nextSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events').get() as {
      seq: number;
    };
    return row.seq;
  }

  /* ---------- 导出 / 导入 ---------- */

  exportAll(exportedAt: number): Archive {
    const fragments = (this.db.prepare('SELECT * FROM fragments ORDER BY digest').all() as unknown as {
      digest: string;
      content: string;
    }[]).map((r) => ({ digest: r.digest, content: JSON.parse(r.content) }));
    return {
      format: 'fringe-book-archive/1',
      exportedAt,
      fragments,
      rawInputs: this.listRaw(),
      interpretations: this.listInterpretations(),
      bundles: this.listBundles(),
      events: this.listEvents(),
    };
  }

  importAll(archive: Archive): void {
    this.clear();
    for (const f of archive.fragments) this.putFragment(f.digest, f.content);
    for (const r of archive.rawInputs) this.putRaw(r);
    for (const i of archive.interpretations) this.putInterpretation(i);
    for (const b of archive.bundles) this.putBundle(b);
    for (const e of archive.events) this.appendEvent(e);
  }
}
