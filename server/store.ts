import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { currentSeq, nextId, type Clock } from './db.js';
import {
  CorruptionError, DomainError, RAW_INPUT_KINDS,
  type EventRecord, type Judgment, type RawInputKind,
} from './types.js';
import { normalizeRaw } from './normalize.js';

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      o[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return o;
  }
  return v;
}

export interface RawInputRow {
  id: string; kind: RawInputKind; contentHash: string;
  raw: unknown; normalized: unknown | null; diagnostics: string[];
  unit: string | null; frame: string | null; createdSeq: number;
}

// 导入原始输入：不可覆盖；原始表示原样保留；无法转换的值留在原位置并附诊断
export function ingestRaw(db: DatabaseSync, clock: Clock, kind: RawInputKind, rawPayload: unknown): RawInputRow {
  if (!RAW_INPUT_KINDS.includes(kind)) {
    throw new DomainError(`未知输入类别: ${kind}`, 'BAD_KIND');
  }
  const rawJson = canonical(rawPayload);
  const contentHash = sha256(rawJson);
  const existing = db.prepare(`SELECT * FROM raw_inputs WHERE kind = ? AND content_hash = ?`)
    .get(kind, contentHash) as Record<string, unknown> | undefined;
  if (existing) return rowToRaw(existing); // 同一内容只存一份不可变内容

  const { normalized, diagnostics, unit, frame } = normalizeRaw(kind, rawPayload);
  const id = `raw_${contentHash.slice(0, 16)}`;
  const seq = currentSeq(db);
  db.prepare(`INSERT INTO raw_inputs(id, kind, content_hash, raw_json, normalized_json, diagnostics_json, unit, frame, created_seq)
              VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(id, kind, contentHash, rawJson,
      normalized === null ? null : canonical(normalized),
      JSON.stringify(diagnostics), unit, frame, seq);
  appendEvent(db, clock, 'raw_ingested', 'raw_input', id, {
    kind, contentHash, diagnostics,
  }, diagnostics.length > 0 ? [{ rule: 'raw_inputs_immutable', detail: { kind, contentHash, diagnostics } }] : null);
  return getRaw(db, id);
}

function rowToRaw(r: Record<string, unknown>): RawInputRow {
  return {
    id: r.id as string, kind: r.kind as RawInputKind,
    contentHash: r.content_hash as string,
    raw: JSON.parse(r.raw_json as string),
    normalized: r.normalized_json ? JSON.parse(r.normalized_json as string) : null,
    diagnostics: JSON.parse(r.diagnostics_json as string),
    unit: r.unit as string | null, frame: r.frame as string | null,
    createdSeq: r.created_seq as number,
  };
}

export function getRaw(db: DatabaseSync, id: string): RawInputRow {
  const r = db.prepare(`SELECT * FROM raw_inputs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!r) throw new CorruptionError(`缺少引用: raw_input ${id} 不存在（不能退回当前最新版）`);
  return rowToRaw(r);
}

export function ensureSource(db: DatabaseSync, clock: Clock, kind: RawInputKind, label: string, id?: string): string {
  const sourceId = id ?? nextId(db, 'src');
  const existing = db.prepare(`SELECT id FROM sources WHERE id = ?`).get(sourceId);
  if (!existing) {
    db.prepare(`INSERT INTO sources(id, kind, label, created_seq) VALUES(?,?,?,?)`)
      .run(sourceId, kind, label, currentSeq(db));
    appendEvent(db, clock, 'source_created', 'source', sourceId, { kind, label }, null);
  }
  return sourceId;
}

// 修订：以新版本和父版本关系表达，绝不覆盖旧版本
export function commitSourceVersion(
  db: DatabaseSync, clock: Clock,
  sourceId: string, rawInputId: string, note: string,
): { versionId: string; versionNo: number } {
  const raw = getRaw(db, rawInputId); // 缺引用即损坏
  const src = db.prepare(`SELECT * FROM sources WHERE id = ?`).get(sourceId) as Record<string, unknown> | undefined;
  if (!src) throw new DomainError(`数据流不存在: ${sourceId}`, 'NO_SOURCE');
  if (src.kind !== raw.kind) {
    throw new DomainError(`类别不匹配: 数据流 ${sourceId} 是 ${src.kind}，不能提交 ${raw.kind}`, 'KIND_MISMATCH');
  }
  const parent = db.prepare(
    `SELECT id, version_no FROM source_versions WHERE source_id = ? ORDER BY version_no DESC LIMIT 1`,
  ).get(sourceId) as { id: string; version_no: number } | undefined;
  const versionNo = parent ? parent.version_no + 1 : 1;
  const versionId = nextId(db, 'sv');
  db.prepare(`INSERT INTO source_versions(id, source_id, version_no, parent_version_id, raw_input_id, note, created_seq)
              VALUES(?,?,?,?,?,?,?)`)
    .run(versionId, sourceId, versionNo, parent?.id ?? null, rawInputId, note, currentSeq(db));
  appendEvent(db, clock, 'source_version_committed', 'source_version', versionId, {
    sourceId, versionNo, parentVersionId: parent?.id ?? null, rawInputId,
    contentHash: raw.contentHash, note,
  }, null);
  return { versionId, versionNo };
}

export interface SourceVersionRow {
  id: string; sourceId: string; versionNo: number;
  parentVersionId: string | null; rawInputId: string; note: string | null; createdSeq: number;
}

export function getSourceVersion(db: DatabaseSync, id: string): SourceVersionRow {
  const r = db.prepare(`SELECT * FROM source_versions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!r) throw new CorruptionError(`缺少引用: source_version ${id} 不存在（不能退回当前最新版）`);
  return {
    id: r.id as string, sourceId: r.source_id as string, versionNo: r.version_no as number,
    parentVersionId: r.parent_version_id as string | null,
    rawInputId: r.raw_input_id as string, note: r.note as string | null,
    createdSeq: r.created_seq as number,
  };
}

export function listSources(db: DatabaseSync): unknown[] {
  const sources = db.prepare(`SELECT * FROM sources ORDER BY id`).all() as Record<string, unknown>[];
  return sources.map((s) => {
    const versions = db.prepare(
      `SELECT sv.*, r.content_hash AS content_hash FROM source_versions sv
       JOIN raw_inputs r ON r.id = sv.raw_input_id
       WHERE sv.source_id = ? ORDER BY sv.version_no`,
    ).all(s.id as string) as Record<string, unknown>[];
    return {
      id: s.id, kind: s.kind, label: s.label,
      versions: versions.map((v) => ({
        id: v.id, versionNo: v.version_no, parentVersionId: v.parent_version_id,
        rawInputId: v.raw_input_id, contentHash: v.content_hash, note: v.note,
      })),
    };
  });
}

export function appendEvent(
  db: DatabaseSync, clock: Clock,
  type: string, entityKind: string | null, entityId: string | null,
  payload: Record<string, unknown>, judgment: Judgment[] | null,
): EventRecord {
  const ts = clock();
  const res = db.prepare(
    `INSERT INTO events(id, ts, type, entity_kind, entity_id, judgment_json, payload_json)
     VALUES(?,?,?,?,?,?,?)`,
  ).run('pending', ts, type, entityKind, entityId,
    judgment ? JSON.stringify(judgment) : null, JSON.stringify(payload));
  const seq = Number(res.lastInsertRowid);
  const id = `evt_${seq}`;
  db.prepare(`UPDATE events SET id = ? WHERE seq = ?`).run(id, seq);
  return { seq, id, ts, type, entityKind, entityId, judgment, payload };
}

export function listEvents(db: DatabaseSync, entityId?: string): EventRecord[] {
  const rows = (entityId
    ? db.prepare(`SELECT * FROM events WHERE entity_id = ? ORDER BY seq`).all(entityId)
    : db.prepare(`SELECT * FROM events ORDER BY seq`).all()) as Record<string, unknown>[];
  return rows.map(rowToEvent);
}

function rowToEvent(r: Record<string, unknown>): EventRecord {
  return {
    seq: r.seq as number, id: r.id as string, ts: r.ts as string,
    type: r.type as string,
    entityKind: r.entity_kind as string | null, entityId: r.entity_id as string | null,
    judgment: r.judgment_json ? JSON.parse(r.judgment_json as string) : null,
    payload: JSON.parse(r.payload_json as string),
  };
}

// 查询任一实体：返回它引用的版本号与内容摘要；缺少引用必须报损坏
export function describeEntity(db: DatabaseSync, kind: string, id: string): unknown {
  if (kind === 'raw_input') {
    const r = getRaw(db, id);
    return { kind, id, contentHash: r.contentHash, unit: r.unit, frame: r.frame, diagnostics: r.diagnostics, raw: r.raw };
  }
  if (kind === 'source_version') {
    const v = getSourceVersion(db, id);
    const raw = getRaw(db, v.rawInputId); // 缺引用 -> CorruptionError
    return {
      kind, id, sourceId: v.sourceId, versionNo: v.versionNo, parentVersionId: v.parentVersionId,
      refs: [{ role: 'raw_input', id: raw.id, contentHash: raw.contentHash }],
    };
  }
  if (kind === 'interpretation') {
    const it = db.prepare(`SELECT * FROM interpretations WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!it) throw new CorruptionError(`缺少引用: interpretation ${id} 不存在`);
    const refs = db.prepare(
      `SELECT role, source_version_id, content_hash FROM interpretation_sources WHERE interpretation_id = ? ORDER BY role`,
    ).all(id) as Record<string, unknown>[];
    for (const ref of refs) getSourceVersion(db, ref.source_version_id as string); // 校验引用完整
    return {
      kind, id, algoVersion: it.algo_version, paramFingerprint: it.param_fingerprint,
      status: it.status, staleReason: it.stale_reason,
      refs: refs.map((r) => ({ role: r.role, sourceVersionId: r.source_version_id, contentHash: r.content_hash })),
    };
  }
  if (kind === 'candidate') {
    const c = db.prepare(`SELECT * FROM candidates WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!c) throw new CorruptionError(`缺少引用: candidate ${id} 不存在`);
    const interp = describeEntity(db, 'interpretation', c.interpretation_id as string);
    return {
      kind, id, interpretationId: c.interpretation_id, candidateKind: c.kind,
      regionId: c.region_id, state: c.state, rejectReason: c.reject_reason,
      interpretation: interp,
    };
  }
  throw new DomainError(`未知实体类别: ${kind}`, 'BAD_ENTITY');
}
