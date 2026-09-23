import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../shared/clock';
import { canonicalize, digestOf } from '../shared/canon';
import type { DomainEvent, EntityKind, EventType, Ref } from '../shared/types';

export class CorruptionError extends Error {
  readonly code = 'CORRUPTION';
  constructor(message: string) {
    super(message);
  }
}

export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(message: string) {
    super(message);
  }
}

export interface VersionRow {
  id: string;
  entityId: string;
  versionNo: number;
  parentId: string | null;
  hash: string;
  seq: number;
  at: string;
  actor: string;
  note: string | null;
}

export interface EntityRow {
  id: string;
  kind: EntityKind;
  seq: number;
}

interface VersionRecord {
  version: VersionRow;
  content: unknown;
  digest: string;
}

/**
 * 内容寻址 + 追加式版本存储。
 * 原始输入一经提交不可覆盖；修订以新版本和父版本关系表达。
 * 缺少引用（版本行存在但内容块丢失）必须报损坏，不能退回当前最新版。
 */
export class Store {
  constructor(
    readonly db: DatabaseSync,
    private clock: Clock,
  ) {}

  private nextSeq(counter: string): number {
    const key = `seq:${counter}`;
    const row = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(key) as { value: string } | undefined;
    const next = (row ? Number(row.value) : 0) + 1;
    this.db
      .prepare(
        'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, String(next));
    return next;
  }

  /** 内容块只存一份不可变内容，相同内容共享同一哈希。 */
  putContent(content: unknown): string {
    const hash = digestOf(content);
    this.db
      .prepare('INSERT OR IGNORE INTO blobs(hash, json) VALUES(?, ?)')
      .run(hash, canonicalize(content));
    return hash;
  }

  getContent(hash: string): unknown {
    const row = this.db.prepare('SELECT json FROM blobs WHERE hash = ?').get(hash) as
      | { json: string }
      | undefined;
    if (!row) {
      throw new CorruptionError(`内容块缺失: ${hash.slice(0, 12)}…（拒绝回退到最新版）`);
    }
    return JSON.parse(row.json);
  }

  createEntity(
    kind: EntityKind,
    content: unknown,
    actor: string,
    note = '',
  ): VersionRecord & { entityId: string } {
    const entitySeq = this.nextSeq('entity');
    const entityId = `ent_${String(entitySeq).padStart(6, '0')}`;
    this.db
      .prepare('INSERT INTO entities(id, kind, seq) VALUES(?, ?, ?)')
      .run(entityId, kind, entitySeq);
    const record = this.appendVersion(entityId, 1, null, content, actor, note);
    return { ...record, entityId };
  }

  reviseEntity(
    entityId: string,
    content: unknown,
    actor: string,
    note = '',
  ): VersionRecord {
    const head = this.headVersionRow(entityId);
    return this.appendVersion(entityId, head.versionNo + 1, head.id, content, actor, note);
  }

  private appendVersion(
    entityId: string,
    versionNo: number,
    parentId: string | null,
    content: unknown,
    actor: string,
    note: string,
  ): VersionRecord {
    const hash = this.putContent(content);
    const seq = this.nextSeq('version');
    const id = `ver_${String(seq).padStart(6, '0')}`;
    this.db
      .prepare(
        'INSERT INTO versions(id, entity_id, version_no, parent_id, hash, seq, at, actor, note) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, entityId, versionNo, parentId, hash, seq, this.clock.now(), actor, note);
    return {
      version: {
        id,
        entityId,
        versionNo,
        parentId,
        hash,
        seq,
        at: this.clock.now(),
        actor,
        note,
      },
      content,
      digest: hash,
    };
  }

  getEntity(entityId: string): EntityRow {
    const row = this.db.prepare('SELECT * FROM entities WHERE id = ?').get(entityId) as
      | { id: string; kind: EntityKind; seq: number }
      | undefined;
    if (!row) throw new NotFoundError(`实体不存在: ${entityId}`);
    return row;
  }

  listEntities(kind?: EntityKind): EntityRow[] {
    const rows = (
      kind
        ? this.db
            .prepare('SELECT * FROM entities WHERE kind = ? ORDER BY seq')
            .all(kind)
        : this.db.prepare('SELECT * FROM entities ORDER BY seq').all()
    ) as unknown as EntityRow[];
    return rows;
  }

  headVersionRow(entityId: string): VersionRow {
    const row = this.db
      .prepare(
        'SELECT * FROM versions WHERE entity_id = ? ORDER BY version_no DESC LIMIT 1',
      )
      .get(entityId) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError(`实体无版本: ${entityId}`);
    return mapVersion(row);
  }

  versionsOf(entityId: string): VersionRow[] {
    const rows = this.db
      .prepare('SELECT * FROM versions WHERE entity_id = ? ORDER BY version_no')
      .all(entityId) as unknown as Record<string, unknown>[];
    return rows.map(mapVersion);
  }

  /** 查询任一实体：返回它引用的版本号与内容摘要；缺引用即报损坏。 */
  getVersion(entityId: string, versionNo?: number): VersionRecord {
    const row = (
      versionNo === undefined
        ? this.db
            .prepare(
              'SELECT * FROM versions WHERE entity_id = ? ORDER BY version_no DESC LIMIT 1',
            )
            .get(entityId)
        : this.db
            .prepare(
              'SELECT * FROM versions WHERE entity_id = ? AND version_no = ?',
            )
            .get(entityId, versionNo)
    ) as Record<string, unknown> | undefined;
    if (!row) {
      throw new NotFoundError(
        `版本不存在: ${entityId}@${versionNo === undefined ? 'head' : versionNo}`,
      );
    }
    const version = mapVersion(row);
    const content = this.getContent(version.hash); // 缺块 → CorruptionError
    return { version, content, digest: version.hash };
  }

  refOf(entityId: string, versionNo?: number): Ref {
    const record = this.getVersion(entityId, versionNo);
    return {
      entityId,
      versionNo: record.version.versionNo,
      digest: record.digest,
    };
  }

  emit(type: EventType, actor: string, payload: Record<string, unknown>): DomainEvent {
    const seq = this.nextSeq('event');
    const id = `evt_${String(seq).padStart(6, '0')}`;
    const at = this.clock.now();
    this.db
      .prepare(
        'INSERT INTO events(id, seq, at, type, actor, json) VALUES(?, ?, ?, ?, ?, ?)',
      )
      .run(id, seq, at, type, actor, canonicalize(payload));
    return { id, seq, at, type, actor, payload };
  }

  events(upToSeq = Number.MAX_SAFE_INTEGER): DomainEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE seq <= ? ORDER BY seq')
      .all(upToSeq) as unknown as {
      id: string;
      seq: number;
      at: string;
      type: EventType;
      actor: string;
      json: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      seq: row.seq,
      at: row.at,
      type: row.type,
      actor: row.actor,
      payload: JSON.parse(row.json) as Record<string, unknown>,
    }));
  }
}

function mapVersion(row: Record<string, unknown>): VersionRow {
  return {
    id: row.id as string,
    entityId: row.entity_id as string,
    versionNo: row.version_no as number,
    parentId: (row.parent_id as string | null) ?? null,
    hash: row.hash as string,
    seq: row.seq as number,
    at: row.at as string,
    actor: row.actor as string,
    note: (row.note as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// 投影：裁定、锁定与撤销都由事件流重放得到；历史只可追加。
// ---------------------------------------------------------------------------

export interface DecisionState {
  status: 'adopted' | 'rejected';
  reason: string;
  seq: number;
}

export interface LockState {
  status: 'active' | 'conflict' | 'resolved';
  seq: number;
  conflictsWith?: string[];
  resolution?: string;
}

export interface Projection {
  decisions: Record<string, DecisionState>; // versionId → 裁定
  locks: Record<string, LockState>; // lock versionId → 状态
}

export function project(events: DomainEvent[], upToSeq = Number.MAX_SAFE_INTEGER): Projection {
  const relevant = events.filter((event) => event.seq <= upToSeq);
  const undone = new Set<number>();
  for (const event of relevant) {
    if (event.type === 'decision.undone') {
      undone.add(Number(event.payload.targetSeq));
    }
  }
  const projection: Projection = { decisions: {}, locks: {} };
  for (const event of relevant) {
    if (undone.has(event.seq)) continue;
    const p = event.payload as Record<string, unknown>;
    switch (event.type) {
      case 'candidate.adopted':
        projection.decisions[String(p.versionId)] = {
          status: 'adopted',
          reason: String(p.reason ?? ''),
          seq: event.seq,
        };
        break;
      case 'candidate.rejected':
        projection.decisions[String(p.versionId)] = {
          status: 'rejected',
          reason: String(p.reason ?? ''),
          seq: event.seq,
        };
        break;
      case 'lock.created':
        projection.locks[String(p.versionId)] = { status: 'active', seq: event.seq };
        break;
      case 'lock.conflict.detected': {
        const a = String(p.lockA);
        const b = String(p.lockB);
        if (projection.locks[a]) {
          projection.locks[a].status = 'conflict';
          projection.locks[a].conflictsWith = [
            ...(projection.locks[a].conflictsWith ?? []),
            b,
          ];
        }
        if (projection.locks[b]) {
          projection.locks[b].status = 'conflict';
          projection.locks[b].conflictsWith = [
            ...(projection.locks[b].conflictsWith ?? []),
            a,
          ];
        }
        break;
      }
      case 'lock.conflict.resolved': {
        const id = String(p.versionId);
        if (projection.locks[id]) {
          projection.locks[id].status = 'resolved';
          projection.locks[id].resolution = String(p.resolution ?? '');
        }
        break;
      }
      default:
        break;
    }
  }
  return projection;
}
