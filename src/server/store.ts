import { createHash } from 'node:crypto';
import type { DatabaseLike, SqlJsStatic } from './db-types.js';
import type { EntityResolution, EventRef, LedgerEvent, EventType } from '../shared/events.js';
import type { CounterexampleKind, VerdictStatus } from '../shared/model.js';
import { canonicalJson, contentHash } from '../core/identity.js';

/**
 * SQLite 事件溯源存储。
 *
 * 表：
 *  projects   项目元信息
 *  events     只追加事件，哈希链 prevHash->hash
 *  entities   实体版本表（stableId, version, digest, summary, payload）
 *  fragments  内容寻址的不可变原始片段（digest 唯一，共享片段只存一份）
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  meta_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,
  at_virtual INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  operator TEXT NOT NULL,
  refs_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  counterexample TEXT,
  verdict TEXT
);
CREATE TABLE IF NOT EXISTS entities (
  stable_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  digest TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  PRIMARY KEY (stable_id, version)
);
CREATE TABLE IF NOT EXISTS fragments (
  digest TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  bytes BLOB NOT NULL,
  canonical_json TEXT NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS fragment_refs (
  digest TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  PRIMARY KEY (digest, owner_id)
);
`;

export interface AppendEventInput {
  eventId: string;
  type: EventType;
  atVirtual: number;
  operator?: string;
  refs?: EventRef[];
  payload?: Record<string, unknown>;
  counterexample?: CounterexampleKind;
  verdict?: VerdictStatus;
}

export class LedgerStore {
  private db: DatabaseLike;

  private constructor(db: DatabaseLike) {
    this.db = db;
  }

  static async open(SQL: SqlJsStatic, bytes?: Uint8Array): Promise<LedgerStore> {
    const db: DatabaseLike = bytes ? new SQL.Database(bytes) : new SQL.Database();
    db.run(SCHEMA);
    return new LedgerStore(db);
  }

  createProject(projectId: string, name: string, createdAt: number, meta: Record<string, unknown> = {}): void {
    this.db.run(
      `INSERT OR IGNORE INTO projects (project_id, name, created_at, meta_json) VALUES (?,?,?,?)`,
      [projectId, name, createdAt, canonicalJson(meta)],
    );
  }

  listProjects(): Array<{ projectId: string; name: string; createdAt: number }> {
    const res = this.db.exec(`SELECT project_id, name, created_at FROM projects ORDER BY created_at`);
    if (!res.length) return [];
    return res[0].values.map((row) => ({
      projectId: String(row[0]),
      name: String(row[1]),
      createdAt: Number(row[2]),
    }));
  }

  lastEvent(projectId: string): LedgerEvent | null {
    const res = this.db.exec(
      `SELECT event_id, hash FROM events WHERE project_id=? ORDER BY seq DESC LIMIT 1`,
    );
    void res;
    const stmt = this.db.prepare(`SELECT * FROM events WHERE project_id=? ORDER BY seq DESC LIMIT 1`);
    stmt.bind([projectId]);
    if (stmt.step()) return rowToEvent(stmt.getAsObject());
    stmt.free();
    return null;
  }

  /** 追加事件：先校验所有引用版本存在，否则报损坏，绝不回退到最新版。 */
  append(projectId: string, input: AppendEventInput): LedgerEvent {
    const prev = this.lastEvent(projectId);
    const refs = input.refs ?? [];
    for (const ref of refs) {
      this.assertRefExists(ref);
    }
    const seq = this.nextSeq(projectId);
    const prevHash = prev?.hash ?? 'GENESIS';
    const refsJson = canonicalJson(refs);
    const payloadJson = canonicalJson(input.payload ?? {});
    const hash = eventHash({
      seq,
      eventId: input.eventId,
      projectId,
      type: input.type,
      atVirtual: input.atVirtual,
      prevHash,
      refsJson,
      payloadJson,
    });
    this.db.run(
      `INSERT INTO events
        (seq, event_id, project_id, type, at_virtual, prev_hash, hash, operator, refs_json, payload_json, counterexample, verdict)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        seq,
        input.eventId,
        projectId,
        input.type,
        input.atVirtual,
        prevHash,
        hash,
        input.operator ?? 'reviewer',
        refsJson,
        payloadJson,
        input.counterexample ?? null,
        input.verdict ?? null,
      ],
    );
    return {
      seq,
      eventId: input.eventId,
      projectId,
      type: input.type,
      atVirtual: input.atVirtual,
      prevHash,
      hash,
      operator: input.operator ?? 'reviewer',
      refs,
      payload: input.payload ?? {},
      counterexample: input.counterexample,
      verdict: input.verdict,
    };
  }

  private nextSeq(projectId: string): number {
    const stmt = this.db.prepare(`SELECT COALESCE(MAX(seq),0)+1 AS s FROM events WHERE project_id=?`);
    stmt.bind([projectId]);
    stmt.step();
    const s = Number(stmt.getAsObject().s);
    stmt.free();
    return s;
  }

  /** 引用必须显式指到存在的版本；缺引用/缺版本 -> 损坏错误 */
  private assertRefExists(ref: EventRef): void {
    const stmt = this.db.prepare(
      `SELECT digest FROM entities WHERE stable_id=? AND version=?`,
    );
    stmt.bind([ref.stableId, ref.version]);
    const exists = stmt.step();
    if (!exists) {
      stmt.free();
      throw new DamagedReferenceError(
        `损坏：引用 ${ref.kind}:${ref.stableId}@v${ref.version} 不存在；禁止回退到最新版`,
      );
    }
    const digest = String(stmt.getAsObject().digest);
    stmt.free();
    if (digest !== ref.digest) {
      throw new DamagedReferenceError(
        `损坏：引用 ${ref.stableId}@v${ref.version} 摘要不匹配（期望 ${ref.digest}，实际 ${digest}）`,
      );
    }
  }

  /** 登记实体版本。返回该版本的 EventRef。 */
  putEntity(
    kind: EventRef['kind'],
    stableId: string,
    version: number,
    summary: string,
    payload: unknown,
    createdSeq: number,
  ): EventRef {
    const digest = contentHash(payload);
    this.db.run(
      `INSERT OR REPLACE INTO entities (stable_id, version, kind, digest, summary, payload_json, created_seq)
       VALUES (?,?,?,?,?,?,?)`,
      [stableId, version, kind, digest, summary, canonicalJson(payload), createdSeq],
    );
    return { kind, stableId, version, digest };
  }

  getEntity(stableId: string, version: number): { payload: unknown; summary: string } | null {
    const stmt = this.db.prepare(`SELECT payload_json, summary FROM entities WHERE stable_id=? AND version=?`);
    stmt.bind([stableId, version]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject();
    stmt.free();
    return { payload: JSON.parse(String(row.payload_json)), summary: String(row.summary) };
  }

  resolve(stableId: string, version: number): EntityResolution {
    const stmt = this.db.prepare(
      `SELECT kind, digest, summary FROM entities WHERE stable_id=? AND version=?`,
    );
    stmt.bind([stableId, version]);
    if (!stmt.step()) {
      stmt.free();
      return {
        kind: 'source',
        stableId,
        version,
        digest: '',
        damaged: true,
        damageReason: 'MISSING_VERSION_NO_LATEST_FALLBACK',
        summary: '',
      };
    }
    const row = stmt.getAsObject();
    stmt.free();
    return {
      kind: String(row.kind) as EntityResolution['kind'],
      stableId,
      version,
      digest: String(row.digest),
      damaged: false,
      summary: String(row.summary),
    };
  }

  events(projectId: string): LedgerEvent[] {
    const stmt = this.db.prepare(`SELECT * FROM events WHERE project_id=? ORDER BY seq ASC`);
    stmt.bind([projectId]);
    const out: LedgerEvent[] = [];
    while (stmt.step()) out.push(rowToEvent(stmt.getAsObject()));
    stmt.free();
    return out;
  }

  /** 校验哈希链完整；任何断裂都报损坏 */
  verifyChain(projectId: string): { ok: boolean; brokenAt: number | null; reason?: string } {
    const events = this.events(projectId);
    let prev = 'GENESIS';
    for (const ev of events) {
      if (ev.prevHash !== prev) return { ok: false, brokenAt: ev.seq, reason: 'PREV_HASH_MISMATCH' };
      const expect = eventHash({
        seq: ev.seq,
        eventId: ev.eventId,
        projectId: ev.projectId,
        type: ev.type,
        atVirtual: ev.atVirtual,
        prevHash: ev.prevHash,
        refsJson: canonicalJson(ev.refs),
        payloadJson: canonicalJson(ev.payload),
      });
      if (expect !== ev.hash) return { ok: false, brokenAt: ev.seq, reason: 'EVENT_HASH_MISMATCH' };
      prev = ev.hash;
    }
    return { ok: true, brokenAt: null };
  }

  /** 内容寻址片段：共享原始片段只存一份不可变内容 */
  putFragment(kind: string, ownerId: string, content: unknown): string {
    const digest = contentHash(content);
    const cj = canonicalJson(content);
    const existing = this.db.exec(`SELECT digest FROM fragments WHERE digest='${digest}'`);
    if (!existing.length) {
      this.db.run(
        `INSERT INTO fragments (digest, kind, bytes, canonical_json, ref_count) VALUES (?,?,?,?,0)`,
        [digest, kind, new Uint8Array(Buffer.from(cj, 'utf8')), cj],
      );
    }
    this.db.run(`INSERT OR IGNORE INTO fragment_refs (digest, owner_id) VALUES (?,?)`, [
      digest,
      ownerId,
    ]);
    this.db.run(`UPDATE fragments SET ref_count=(SELECT COUNT(*) FROM fragment_refs WHERE digest=?) WHERE digest=?`, [
      digest,
      digest,
    ]);
    return digest;
  }

  getFragment(digest: string): unknown | null {
    const stmt = this.db.prepare(`SELECT canonical_json FROM fragments WHERE digest=?`);
    stmt.bind([digest]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const out = JSON.parse(String(stmt.getAsObject().canonical_json));
    stmt.free();
    return out;
  }

  fragmentCount(): number {
    const res = this.db.exec(`SELECT COUNT(*) FROM fragments`);
    return Number(res[0]?.values[0]?.[0] ?? 0);
  }

  /** 导出整个数据库为字节（.sqlite），身份/顺序/关系全在其中 */
  exportBytes(): Uint8Array {
    return this.db.export();
  }

  close(): void {
    this.db.close();
  }
}

export class DamagedReferenceError extends Error {}

interface HashParts {
  seq: number;
  eventId: string;
  projectId: string;
  type: string;
  atVirtual: number;
  prevHash: string;
  refsJson: string;
  payloadJson: string;
}

function eventHash(p: HashParts): string {
  return 'sha256:' + createHash('sha256').update(canonicalJson(p)).digest('hex');
}

function rowToEvent(row: Record<string, unknown>): LedgerEvent {
  return {
    seq: Number(row.seq),
    eventId: String(row.event_id),
    projectId: String(row.project_id),
    type: String(row.type) as EventType,
    atVirtual: Number(row.at_virtual),
    prevHash: String(row.prev_hash),
    hash: String(row.hash),
    operator: String(row.operator),
    refs: JSON.parse(String(row.refs_json)) as EventRef[],
    payload: JSON.parse(String(row.payload_json)),
    counterexample: (row.counterexample as CounterexampleKind) ?? undefined,
    verdict: (row.verdict as VerdictStatus) ?? undefined,
  };
}
