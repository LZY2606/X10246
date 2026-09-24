import { ReviewStore } from "./store.js";
import { sha256Hex } from "../domain/ids.js";
import { stableStringify } from "../domain/canonical.js";
import { CorruptArchiveError } from "./db.js";

export interface ArchiveFile {
  format: "ifx-review-archive";
  formatVersion: 1;
  exportedAt: number;
  blobs: Array<{ blobId: string; mediaType: string; bytesBase64: string; sha256: string }>;
  versions: Array<{
    entityId: string;
    version: number;
    parentVersion: number | null;
    kind: string;
    blobId: string;
    payloadJson: string;
    summary: string;
    fingerprint: string;
    createdAt: number;
  }>;
  events: Array<{ seq: number; payloadJson: string }>;
  pointers: Array<{ name: string; entityId: string; version: number }>;
  runs: Array<{ runId: string; situation: string; mode: string; createdAt: number; fragmentBlobIds: string; note: string }>;
}

export function exportArchive(store: ReviewStore, exportedAt = store.now()): ArchiveFile {
  const blobRows = store.db
    .prepare("SELECT blob_id, media_type, byte_count, sha256, bytes, created_at FROM blobs ORDER BY blob_id")
    .all() as Array<{
    blob_id: string;
    media_type: string;
    byte_count: number;
    sha256: string;
    bytes: Uint8Array;
    created_at: number;
  }>;
  const versionRows = store.db
    .prepare(
      "SELECT entity_id, version, parent_version, kind, blob_id, payload_json, summary, fingerprint, created_at FROM entity_versions ORDER BY entity_id, version"
    )
    .all() as Array<{
    entity_id: string;
    version: number;
    parent_version: number | null;
    kind: string;
    blob_id: string;
    payload_json: string;
    summary: string;
    fingerprint: string;
    created_at: number;
  }>;
  const eventRows = store.db.prepare("SELECT seq, payload_json FROM events ORDER BY seq").all() as Array<{
    seq: number;
    payload_json: string;
  }>;
  const pointerRows = store.db.prepare("SELECT name, entity_id, version FROM pointers ORDER BY name").all() as Array<{
    name: string;
    entity_id: string;
    version: number;
  }>;
  const runRows = store.db
    .prepare("SELECT run_id, situation, mode, created_at, fragment_blob_ids, note FROM runs ORDER BY run_id")
    .all() as Array<{
    run_id: string;
    situation: string;
    mode: string;
    created_at: number;
    fragment_blob_ids: string;
    note: string;
  }>;

  return {
    format: "ifx-review-archive",
    formatVersion: 1,
    exportedAt,
    blobs: blobRows.map((b) => ({
      blobId: b.blob_id,
      mediaType: b.media_type,
      bytesBase64: Buffer.from(b.bytes).toString("base64"),
      sha256: b.sha256
    })),
    versions: versionRows.map((v) => ({
      entityId: v.entity_id,
      version: v.version,
      parentVersion: v.parent_version,
      kind: v.kind,
      blobId: v.blob_id,
      payloadJson: v.payload_json,
      summary: v.summary,
      fingerprint: v.fingerprint,
      createdAt: v.created_at
    })),
    events: eventRows.map((e) => ({ seq: e.seq, payloadJson: e.payload_json })),
    pointers: pointerRows.map((p) => ({ name: p.name, entityId: p.entity_id, version: p.version })),
    runs: runRows.map((r) => ({
      runId: r.run_id,
      situation: r.situation,
      mode: r.mode,
      createdAt: r.created_at,
      fragmentBlobIds: JSON.parse(r.fragment_blob_ids),
      note: r.note
    }))
  };
}

export function importArchive(target: ReviewStore, archive: ArchiveFile): { entities: number; events: number; blobs: number } {
  if (archive.format !== "ifx-review-archive" || archive.formatVersion !== 1) {
    throw new CorruptArchiveError("PAYLOAD_MISMATCH", "unsupported archive format/version");
  }
  const tx = target.db;
  tx.exec("BEGIN");
  try {
    let blobs = 0;
    for (const b of archive.blobs) {
      const bytes = Buffer.from(b.bytesBase64, "base64");
      const hash = sha256Hex(bytes.toString("utf-8"));
      if (hash !== b.sha256) {
        throw new CorruptArchiveError("FINGERPRINT_MISMATCH", `blob ${b.blobId} sha256 mismatch`);
      }
      const exists = tx.prepare("SELECT 1 FROM blobs WHERE blob_id = ?").get(b.blobId);
      if (!exists) {
        tx.prepare(
          "INSERT INTO blobs(blob_id, media_type, byte_count, sha256, bytes, created_at) VALUES(?,?,?,?,?,?)"
        ).run(b.blobId, b.mediaType, bytes.length, b.sha256, bytes, archive.exportedAt);
        blobs++;
      }
    }

    for (const v of archive.versions) {
      if (sha256Hex(v.payloadJson) !== v.fingerprint) {
        throw new CorruptArchiveError("FINGERPRINT_MISMATCH", `payload fingerprint mismatch ${v.entityId}@v${v.version}`);
      }
      if (!archive.blobs.some((b) => b.blobId === v.blobId)) {
        throw new CorruptArchiveError("MISSING_BLOB", `version ${v.entityId}@v${v.version} references missing blob ${v.blobId}`);
      }
      const payload = JSON.parse(v.payloadJson) as { sources?: Array<{ entityId: string; version: number }> };
      for (const ref of payload.sources ?? []) {
        const hit = archive.versions.some(
          (candidate) => candidate.entityId === ref.entityId && candidate.version === ref.version
        );
        if (!hit) {
          throw new CorruptArchiveError(
            "MISSING_REFERENCED_VERSION",
            `${v.entityId}@v${v.version} references missing ${ref.entityId}@v${ref.version}`,
            { entityId: ref.entityId, version: ref.version }
          );
        }
      }
    }

    const entities = new Set<string>();
    for (const v of archive.versions) {
      entities.add(v.entityId);
      tx.prepare("INSERT OR IGNORE INTO entities(entity_id, kind, created_at) VALUES(?,?,?)").run(
        v.entityId,
        v.kind,
        v.createdAt
      );
      tx.prepare(
        `INSERT OR IGNORE INTO entity_versions(entity_id, version, parent_version, kind, blob_id, payload_json, summary, fingerprint, created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`
      ).run(v.entityId, v.version, v.parentVersion, v.kind, v.blobId, v.payloadJson, v.summary, v.fingerprint, v.createdAt);
      const payload = JSON.parse(v.payloadJson) as { sources?: Array<{ entityId: string; version: number; role?: string }> };
      for (const ref of payload.sources ?? []) {
        tx.prepare(
          `INSERT OR IGNORE INTO refs(source_entity, source_version, source_role, target_entity, target_version, target_role)
           VALUES(?,?,?,?,?,?)`
        ).run(v.entityId, v.version, "sources", ref.entityId, ref.version, ref.role ?? "sources");
      }
    }

    for (const e of archive.events) {
      const payload = JSON.parse(e.payloadJson) as {
        eventId: string;
        type: string;
        at: number;
        actor: string;
        situation: string | null;
        runId: string | null;
        subject: { entityId: string; version: number } | null;
      };
      tx.prepare(
        `INSERT OR IGNORE INTO events(seq, event_id, event_type, at, actor, situation, run_id, subject_entity, subject_version, payload_json)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      ).run(
        e.seq,
        payload.eventId,
        payload.type,
        payload.at,
        payload.actor,
        payload.situation,
        payload.runId,
        payload.subject?.entityId ?? null,
        payload.subject?.version ?? null,
        e.payloadJson
      );
    }

    for (const p of archive.pointers) {
      tx.prepare("INSERT OR REPLACE INTO pointers(name, entity_id, version) VALUES(?,?,?)").run(
        p.name,
        p.entityId,
        p.version
      );
    }
    for (const r of archive.runs) {
      tx.prepare(
        "INSERT OR REPLACE INTO runs(run_id, situation, mode, created_at, fragment_blob_ids, note) VALUES(?,?,?,?,?,?)"
      ).run(r.runId, r.situation, r.mode, r.createdAt, stableStringify(r.fragmentBlobIds), r.note);
    }

    const integrity = target.verifyIntegrity();
    if (!integrity.ok) {
      throw new CorruptArchiveError("PAYLOAD_MISMATCH", `post-import integrity failure: ${integrity.errors.join("; ")}`);
    }
    tx.exec("COMMIT");
    return { entities: entities.size, events: archive.events.length, blobs };
  } catch (err) {
    tx.exec("ROLLBACK");
    throw err;
  }
}
