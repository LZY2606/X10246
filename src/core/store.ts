/**
 * 持久化存储：事件溯源 + 不可变输入版本 + 内容寻址原始片段。
 * 查询任一实体返回其引用的版本号与内容摘要；缺少引用必须报损坏，不能退回最新版。
 */
import type { DatabaseSync } from "node:sqlite";
import { contentDigest, stableId } from "../domain/hash";
import type { Clock } from "../domain/clock";
import type { InputKind } from "../domain/types";
import type { DomainEvent, EventType } from "./events";

export class CorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptionError";
  }
}

export class ImmutabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImmutabilityError";
  }
}

export interface VersionRef {
  entityId: string;
  versionNo: number;
  digest: string;
}

export interface DerivedRecord {
  resultId: string;
  kind: "unwrap" | "height";
  algorithmVersion: string;
  paramFingerprint: string;
  sources: VersionRef[];
  payload: unknown;
  digest: string;
  createdAt: string;
}

export class Store {
  constructor(
    private db: DatabaseSync,
    private clock: Clock,
  ) {}

  // ---------- 原始片段（内容寻址，共享只存一份） ----------
  putBlob(content: unknown): string {
    const digest = contentDigest(content);
    this.db
      .prepare("INSERT OR IGNORE INTO blobs(digest, content) VALUES (?, ?)")
      .run(digest, JSON.stringify(content));
    return digest;
  }

  getBlob(digest: string): unknown {
    const row = this.db.prepare("SELECT content FROM blobs WHERE digest = ?").get(digest) as
      | { content: string }
      | undefined;
    if (!row) throw new CorruptionError(`缺少原始片段 ${digest}，档案损坏`);
    return JSON.parse(row.content);
  }

  // ---------- 输入实体与版本 ----------
  createEntity(kind: InputKind, entityId?: string): string {
    const id = entityId ?? stableId("ent", { kind }, Date.now() % 1_000_000);
    const exists = this.db.prepare("SELECT entity_id FROM input_entities WHERE entity_id = ?").get(id);
    if (exists) throw new ImmutabilityError(`实体 ${id} 已存在，输入实体不可覆盖`);
    this.db
      .prepare("INSERT INTO input_entities(entity_id, kind, created_at) VALUES (?, ?, ?)")
      .run(id, kind, this.clock.now());
    return id;
  }

  /** 追加不可变版本；同版本号写入视为覆盖尝试，拒绝。 */
  addVersion(
    entityId: string,
    payload: unknown,
    opts: { note?: string; expectedVersionNo?: number } = {},
  ): VersionRef {
    const ent = this.db
      .prepare("SELECT kind FROM input_entities WHERE entity_id = ?")
      .get(entityId) as { kind: string } | undefined;
    if (!ent) throw new CorruptionError(`实体 ${entityId} 不存在`);
    const head = this.db
      .prepare("SELECT MAX(version_no) AS v FROM input_versions WHERE entity_id = ?")
      .get(entityId) as { v: number | null };
    const versionNo = opts.expectedVersionNo ?? (head.v ?? 0) + 1;
    const dup = this.db
      .prepare("SELECT 1 FROM input_versions WHERE entity_id = ? AND version_no = ?")
      .get(entityId, versionNo);
    if (dup) {
      throw new ImmutabilityError(
        `实体 ${entityId} 版本 ${versionNo} 已存在：原始输入一经提交不可覆盖，请以新版本修订`,
      );
    }
    const blobDigest = this.putBlob(payload);
    const digest = contentDigest({ entityId, versionNo, payload });
    this.db
      .prepare(
        "INSERT INTO input_versions(entity_id, version_no, parent_version_no, blob_digest, digest, created_at, note) VALUES (?,?,?,?,?,?,?)",
      )
      .run(entityId, versionNo, head.v ?? null, blobDigest, digest, this.clock.now(), opts.note ?? null);
    return { entityId, versionNo, digest };
  }

  /** 查询指定版本：返回版本号与内容摘要；缺少引用报损坏，不退回最新版。 */
  resolveVersion(entityId: string, versionNo: number): { ref: VersionRef; content: unknown } {
    const row = this.db
      .prepare("SELECT blob_digest, digest FROM input_versions WHERE entity_id = ? AND version_no = ?")
      .get(entityId, versionNo) as { blob_digest: string; digest: string } | undefined;
    if (!row) {
      throw new CorruptionError(`实体 ${entityId} 的版本 ${versionNo} 缺失，档案损坏（不退回最新版）`);
    }
    const content = this.getBlob(row.blob_digest);
    return { ref: { entityId, versionNo, digest: row.digest }, content };
  }

  headVersion(entityId: string): VersionRef | null {
    const row = this.db
      .prepare(
        "SELECT version_no, digest FROM input_versions WHERE entity_id = ? ORDER BY version_no DESC LIMIT 1",
      )
      .get(entityId) as { version_no: number; digest: string } | undefined;
    return row ? { entityId, versionNo: row.version_no, digest: row.digest } : null;
  }

  listEntities(): Array<{ entityId: string; kind: InputKind; headVersionNo: number | null; headDigest: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT e.entity_id AS id, e.kind AS kind,
                (SELECT MAX(version_no) FROM input_versions v WHERE v.entity_id = e.entity_id) AS head
         FROM input_entities e ORDER BY e.rowid`,
      )
      .all() as Array<{ id: string; kind: InputKind; head: number | null }>;
    return rows.map((r) => {
      const head = r.head == null ? null : this.resolveVersion(r.id, r.head).ref;
      return { entityId: r.id, kind: r.kind, headVersionNo: r.head, headDigest: head?.digest ?? null };
    });
  }

  versionHistory(entityId: string): VersionRef[] {
    const rows = this.db
      .prepare("SELECT version_no, digest FROM input_versions WHERE entity_id = ? ORDER BY version_no")
      .all(entityId) as Array<{ version_no: number; digest: string }>;
    return rows.map((r) => ({ entityId, versionNo: r.version_no, digest: r.digest }));
  }

  // ---------- 派生结果 ----------
  putDerived(rec: Omit<DerivedRecord, "digest" | "createdAt">): DerivedRecord {
    const digest = contentDigest({ id: rec.resultId, payload: rec.payload, sources: rec.sources });
    const createdAt = this.clock.now();
    this.db
      .prepare(
        "INSERT INTO derived_results(result_id, kind, algorithm_version, param_fingerprint, sources, payload, digest, created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        rec.resultId,
        rec.kind,
        rec.algorithmVersion,
        rec.paramFingerprint,
        JSON.stringify(rec.sources),
        JSON.stringify(rec.payload),
        digest,
        createdAt,
      );
    return { ...rec, digest, createdAt };
  }

  getDerived(resultId: string): DerivedRecord {
    const row = this.db.prepare("SELECT * FROM derived_results WHERE result_id = ?").get(resultId) as
      | Record<string, string>
      | undefined;
    if (!row) throw new CorruptionError(`派生结果 ${resultId} 缺失，档案损坏`);
    return {
      resultId: row.result_id!,
      kind: row.kind as "unwrap" | "height",
      algorithmVersion: row.algorithm_version!,
      paramFingerprint: row.param_fingerprint!,
      sources: JSON.parse(row.sources!),
      payload: JSON.parse(row.payload!),
      digest: row.digest!,
      createdAt: row.created_at!,
    };
  }

  listDerived(kind?: string): DerivedRecord[] {
    const rows = (
      kind
        ? this.db.prepare("SELECT result_id FROM derived_results WHERE kind = ? ORDER BY created_at, result_id").all(kind)
        : this.db.prepare("SELECT result_id FROM derived_results ORDER BY created_at, result_id").all()
    ) as Array<{ result_id: string }>;
    return rows.map((r) => this.getDerived(r.result_id));
  }

  // ---------- 事件 ----------
  appendEvent(type: EventType, payload: unknown, forcedSeq?: number, forcedId?: string, forcedAt?: string): DomainEvent {
    const seqRow = this.db.prepare("SELECT MAX(seq) AS s FROM events").get() as { s: number | null };
    const seq = forcedSeq ?? (seqRow.s ?? 0) + 1;
    const eventId = forcedId ?? stableId("evt", { type, payload }, seq);
    const at = forcedAt ?? this.clock.now();
    this.db
      .prepare("INSERT INTO events(seq, event_id, type, at, payload) VALUES (?,?,?,?,?)")
      .run(seq, eventId, type, at, JSON.stringify(payload));
    return { seq, eventId, type, at, payload };
  }

  events(upToSeq?: number): DomainEvent[] {
    const rows = (
      upToSeq == null
        ? this.db.prepare("SELECT * FROM events ORDER BY seq").all()
        : this.db.prepare("SELECT * FROM events WHERE seq <= ? ORDER BY seq").all(upToSeq)
    ) as Array<{ seq: number; event_id: string; type: EventType; at: string; payload: string }>;
    return rows.map((r) => ({
      seq: r.seq,
      eventId: r.event_id,
      type: r.type,
      at: r.at,
      payload: JSON.parse(r.payload),
    }));
  }

  // ---------- 引用完整性 ----------
  /** 校验所有派生结果与事件的引用；任何缺失都报损坏。 */
  verifyIntegrity(): { ok: boolean; damages: string[] } {
    const damages: string[] = [];
    for (const rec of this.listDerived()) {
      for (const src of rec.sources) {
        try {
          this.resolveVersion(src.entityId, src.versionNo);
        } catch (e) {
          damages.push(`派生结果 ${rec.resultId} 引用缺失：${(e as Error).message}`);
        }
      }
    }
    return { ok: damages.length === 0, damages };
  }
}
