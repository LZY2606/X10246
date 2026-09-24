/**
 * 导出/导入：删除本地数据库再导入后，身份、顺序和来源关系保持。
 * 所有身份为内容寻址稳定身份，事件顺序以 seq 显式保存。
 */
import { Store, CorruptionError } from "./store";
import { contentDigest } from "../domain/hash";

export interface ExportBundle {
  format: "interferometry-review-bundle";
  schemaVersion: number;
  blobs: Array<{ digest: string; content: unknown }>;
  entities: Array<{ entityId: string; kind: string; createdAt: string }>;
  versions: Array<{
    entityId: string;
    versionNo: number;
    parentVersionNo: number | null;
    blobDigest: string;
    digest: string;
    createdAt: string;
    note: string | null;
  }>;
  derived: Array<{
    resultId: string;
    kind: string;
    algorithmVersion: string;
    paramFingerprint: string;
    sources: unknown;
    payload: unknown;
    digest: string;
    createdAt: string;
  }>;
  events: Array<{ seq: number; eventId: string; type: string; at: string; payload: unknown }>;
  bundleDigest: string;
}

export function exportBundle(db: import("node:sqlite").DatabaseSync): ExportBundle {
  const blobs = db.prepare("SELECT digest, content FROM blobs ORDER BY rowid").all() as Array<{ digest: string; content: string }>;
  const entities = db.prepare("SELECT entity_id, kind, created_at FROM input_entities ORDER BY rowid").all() as Array<{ entity_id: string; kind: string; created_at: string }>;
  const versions = db.prepare("SELECT * FROM input_versions ORDER BY entity_id, version_no").all() as Array<Record<string, unknown>>;
  const derived = db.prepare("SELECT * FROM derived_results ORDER BY rowid").all() as Array<Record<string, unknown>>;
  const events = db.prepare("SELECT * FROM events ORDER BY seq").all() as Array<Record<string, unknown>>;
  const bundle: ExportBundle = {
    format: "interferometry-review-bundle",
    schemaVersion: 1,
    blobs: blobs.map((b) => ({ digest: b.digest, content: JSON.parse(b.content) })),
    entities: entities.map((e) => ({ entityId: e.entity_id, kind: e.kind, createdAt: e.created_at })),
    versions: versions.map((v) => ({
      entityId: v.entity_id as string,
      versionNo: v.version_no as number,
      parentVersionNo: (v.parent_version_no as number | null) ?? null,
      blobDigest: v.blob_digest as string,
      digest: v.digest as string,
      createdAt: v.created_at as string,
      note: (v.note as string | null) ?? null,
    })),
    derived: derived.map((d) => ({
      resultId: d.result_id as string,
      kind: d.kind as string,
      algorithmVersion: d.algorithm_version as string,
      paramFingerprint: d.param_fingerprint as string,
      sources: JSON.parse(d.sources as string),
      payload: JSON.parse(d.payload as string),
      digest: d.digest as string,
      createdAt: d.created_at as string,
    })),
    events: events.map((e) => ({
      seq: e.seq as number,
      eventId: e.event_id as string,
      type: e.type as string,
      at: e.at as string,
      payload: JSON.parse(e.payload as string),
    })),
    bundleDigest: "",
  };
  bundle.bundleDigest = contentDigest({ ...bundle, bundleDigest: "" });
  return bundle;
}

/** 导入到（应为空的）数据库；保持身份、顺序与来源关系。 */
export function importBundle(db: import("node:sqlite").DatabaseSync, store: Store, bundle: ExportBundle): void {
  if (bundle.format !== "interferometry-review-bundle") {
    throw new CorruptionError("导入包格式不符：不是 interferometry-review-bundle");
  }
  const digestCheck = contentDigest({ ...bundle, bundleDigest: "" });
  if (digestCheck !== bundle.bundleDigest) {
    throw new CorruptionError("导入包摘要校验失败，档案损坏");
  }
  const count = (db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;
  if (count > 0) throw new Error("目标数据库非空：请先删除本地数据库再导入");

  const insertBlob = db.prepare("INSERT INTO blobs(digest, content) VALUES (?, ?)");
  const insertEntity = db.prepare("INSERT INTO input_entities(entity_id, kind, created_at) VALUES (?,?,?)");
  const insertVersion = db.prepare(
    "INSERT INTO input_versions(entity_id, version_no, parent_version_no, blob_digest, digest, created_at, note) VALUES (?,?,?,?,?,?,?)",
  );
  const insertDerived = db.prepare(
    "INSERT INTO derived_results(result_id, kind, algorithm_version, param_fingerprint, sources, payload, digest, created_at) VALUES (?,?,?,?,?,?,?,?)",
  );
  const insertEvent = db.prepare("INSERT INTO events(seq, event_id, type, at, payload) VALUES (?,?,?,?,?)");

  for (const b of bundle.blobs) {
    const d = contentDigest(b.content);
    if (d !== b.digest) throw new CorruptionError(`原始片段 ${b.digest} 内容摘要不符，档案损坏`);
    insertBlob.run(b.digest, JSON.stringify(b.content));
  }
  for (const e of bundle.entities) insertEntity.run(e.entityId, e.kind, e.createdAt);
  for (const v of bundle.versions) {
    insertVersion.run(v.entityId, v.versionNo, v.parentVersionNo, v.blobDigest, v.digest, v.createdAt, v.note);
  }
  for (const d of bundle.derived) {
    insertDerived.run(
      d.resultId, d.kind, d.algorithmVersion, d.paramFingerprint,
      JSON.stringify(d.sources), JSON.stringify(d.payload), d.digest, d.createdAt,
    );
  }
  for (const e of bundle.events) insertEvent.run(e.seq, e.eventId, e.type, e.at, JSON.stringify(e.payload));

  const integrity = store.verifyIntegrity();
  if (!integrity.ok) throw new CorruptionError(`导入后引用完整性校验失败：${integrity.damages.join("; ")}`);
  store.appendEvent("import.completed", {
    entities: bundle.entities.length,
    versions: bundle.versions.length,
    derived: bundle.derived.length,
    events: bundle.events.length,
    bundleDigest: bundle.bundleDigest,
  });
}
