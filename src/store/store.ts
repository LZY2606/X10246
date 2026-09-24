import { DatabaseSync } from "node:sqlite";
import { openDatabase, CorruptArchiveError } from "./db.js";
import { contentId, sha256Hex } from "../domain/ids.js";
import { canonicalize, stableStringify } from "../domain/canonical.js";
import type { AnyEntityVersion, Ref } from "../domain/entities.js";
import type { ReviewEvent } from "../domain/events.js";

export interface StoredVersion {
  entityId: string;
  version: number;
  parentVersion: number | null;
  kind: string;
  blobId: string;
  payload: AnyEntityVersion;
  summary: string;
  fingerprint: string;
  createdAt: number;
}

export interface BlobRecord {
  blobId: string;
  mediaType: string;
  bytes: Buffer;
  sha256: string;
}

const ARRAY_BLOBS = new Set([
  "WrappedPhaseFrame",
  "AmplitudeFrame",
  "QualityScoreFrame",
  "InvalidMask"
]);

function summarize(kind: string, payload: Record<string, unknown>): string {
  switch (kind) {
    case "WrappedPhaseFrame":
      return `wrapped phase ${payload.grid ? (payload.grid as { cols: number; rows: number }).cols : 0}x${payload.grid ? (payload.grid as { rows: number }).rows : 0} ${payload.phaseUnit}, diagnostics=${(payload.diagnostics as unknown[]).length}`;
    case "AmplitudeFrame":
      return `amplitude ${payload.amplitudeUnit}, lowAmpThreshold=${payload.lowAmplitudeThreshold}`;
    case "QualityScoreFrame":
      return `quality scores ${payload.scoreUnit}`;
    case "InvalidMask":
      return `invalid mask, invalid cells=${(payload.invalid as boolean[]).filter(Boolean).length}`;
    case "WavelengthSpec": {
      const w = payload.wavelength as { value: number; unit: string };
      return `lambda=${w.value} ${w.unit}${payload.diagnostic ? " (unconvertible)" : ""}`;
    }
    case "IlluminationGeometry": {
      const a = payload.incidenceAngle as { value: number };
      return `incidence=${a.value}deg sensitivityFactor=${(payload.sensitivityFactor as number).toFixed(4)}`;
    }
    case "CalibrationPlane":
      return `calibration ${payload.method} residualRmsM=${payload.residualRmsM}`;
    case "CutEditHistory":
      return `cut edits=${(payload.edits as unknown[]).length}`;
    case "QualityMap":
      return `quality map components=${payload.componentCount}, algo=${payload.algorithm}`;
    case "ResidueMap":
      return `residues=${(payload.residues as unknown[]).length}, boundaryCharge=${payload.boundaryCharge}`;
    case "BranchCutNetwork":
      return `cuts=${(payload.edges as unknown[]).length} unpaired=${(payload.unpairedResidues as unknown[]).length}`;
    case "UnwrapTree":
      return `tree ${payload.strategy} region=${payload.region} edges=${(payload.edges as unknown[]).length} candidates=${(payload.candidates as unknown[]).length}`;
    case "CycleResidualSet":
      return `cycles=${(payload.cycles as unknown[]).length}`;
    case "HeightChain":
      return `height chain cells=${(payload.cells as unknown[]).length} stale=${payload.stale}`;
    case "LocalLock":
      return `lock ${payload.state} on ${(payload.targetRef as Ref).entityId}@v${(payload.targetRef as Ref).version}`;
    default:
      return kind;
  }
}

export class ReviewStore {
  readonly db: DatabaseSync;
  private clock: () => number;

  constructor(filename: string, clock: () => number = () => Date.now()) {
    this.db = openDatabase(filename);
    this.clock = clock;
  }

  now(): number {
    return this.clock();
  }

  setClock(clock: () => number): void {
    this.clock = clock;
  }

  close(): void {
    this.db.close();
  }

  putBlob(data: unknown, mediaType = "application/json"): BlobRecord {
    const bytes = Buffer.from(
      mediaType === "application/json" ? stableStringify(data) : (data as string),
      "utf-8"
    );
    const hash = sha256Hex(bytes.toString("utf-8"));
    const blobId = contentId("blob", { hash, byteCount: bytes.length });
    const existing = this.db.prepare("SELECT blob_id FROM blobs WHERE blob_id = ?").get(blobId);
    if (!existing) {
      this.db
        .prepare(
          "INSERT INTO blobs(blob_id, media_type, byte_count, sha256, bytes, created_at) VALUES(?,?,?,?,?,?)"
        )
        .run(blobId, mediaType, bytes.length, hash, bytes, this.now());
    }
    return { blobId, mediaType, bytes, sha256: hash };
  }

  getBlob(blobId: string): BlobRecord | null {
    const row = this.db
      .prepare("SELECT blob_id, media_type, bytes, sha256 FROM blobs WHERE blob_id = ?")
      .get(blobId) as
      | { blob_id: string; media_type: string; bytes: Uint8Array; sha256: string }
      | undefined;
    if (!row) return null;
    const bytes = Buffer.from(row.bytes);
    return { blobId: row.blob_id, mediaType: row.media_type, bytes, sha256: row.sha256 };
  }

  private nextVersion(entityId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM entity_versions WHERE entity_id = ?")
      .get(entityId) as { v: number };
    return row.v + 1;
  }

  putVersion(payload: Omit<AnyEntityVersion, "version" | "parentVersion" | "createdAt"> & {
    version?: number;
    parentVersion?: number | null;
  }): StoredVersion {
    const entityId = payload.entityId;
    const existingEntity = this.db.prepare("SELECT entity_id FROM entities WHERE entity_id = ?").get(entityId);
    const version = payload.version ?? this.nextVersion(entityId);
    const parentVersion =
      payload.parentVersion === undefined ? (version > 1 ? version - 1 : null) : payload.parentVersion;

    const fullPayload = {
      ...canonicalize(payload),
      version,
      parentVersion,
      createdAt: this.now(),
      immutable: payload.kind === "LocalLock" ? payload.immutable : true
    } as AnyEntityVersion;

    const fingerprint = sha256Hex(stableStringify(fullPayload));
    let blobId: string;
    if (ARRAY_BLOBS.has(payload.kind)) {
      const frame = fullPayload as unknown as {
        rawTokens: string[];
        wrappedRadians?: number[];
        amplitudes?: number[];
        scores?: number[];
        invalid?: boolean[];
      };
      const arrays: Record<string, unknown> = { rawTokens: frame.rawTokens };
      if (frame.wrappedRadians) arrays.wrappedRadians = frame.wrappedRadians;
      if (frame.amplitudes) arrays.amplitudes = frame.amplitudes;
      if (frame.scores) arrays.scores = frame.scores;
      if (frame.invalid) arrays.invalid = frame.invalid;
      blobId = this.putBlob(arrays).blobId;
    } else {
      blobId = this.putBlob(fullPayload).blobId;
    }

    if (!existingEntity) {
      this.db.prepare("INSERT INTO entities(entity_id, kind, created_at) VALUES(?,?,?)").run(
        entityId,
        payload.kind,
        this.now()
      );
    }

    const summary = summarize(payload.kind, fullPayload as unknown as Record<string, unknown>);
    this.db
      .prepare(
        `INSERT INTO entity_versions(entity_id, version, parent_version, kind, blob_id, payload_json, summary, fingerprint, created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`
      )
      .run(
        entityId,
        version,
        parentVersion,
        payload.kind,
        blobId,
        stableStringify(fullPayload),
        summary,
        fingerprint,
        this.now()
      );

    const sources = (fullPayload as unknown as { sources?: Ref[] }).sources ?? [];
    for (const ref of sources) {
      this.db
        .prepare(
          `INSERT INTO refs(source_entity, source_version, source_role, target_entity, target_version, target_role)
           VALUES(?,?,?,?,?,?)`
        )
        .run(entityId, version, "sources", ref.entityId, ref.version, ref.role);
    }

    return {
      entityId,
      version,
      parentVersion,
      kind: payload.kind,
      blobId,
      payload: fullPayload,
      summary,
      fingerprint,
      createdAt: this.now()
    };
  }

  getVersion(ref: Ref): StoredVersion {
    const row = this.db
      .prepare(
        "SELECT payload_json, fingerprint, blob_id, summary FROM entity_versions WHERE entity_id = ? AND version = ?"
      )
      .get(ref.entityId, ref.version) as
      | { payload_json: string; fingerprint: string; blob_id: string; summary: string }
      | undefined;
    if (!row) {
      throw new CorruptArchiveError(
        "MISSING_REFERENCED_VERSION",
        `entity query references ${ref.entityId}@v${ref.version} (${ref.role}) which does not exist; refusing to fall back to latest`,
        { entityId: ref.entityId, version: ref.version }
      );
    }
    const payload = JSON.parse(row.payload_json) as AnyEntityVersion;
    if (sha256Hex(row.payload_json) !== row.fingerprint) {
      throw new CorruptArchiveError(
        "FINGERPRINT_MISMATCH",
        `stored payload for ${ref.entityId}@v${ref.version} fails fingerprint check`,
        { entityId: ref.entityId, version: ref.version }
      );
    }
    const blob = this.getBlob(row.blob_id);
    if (!blob) {
      throw new CorruptArchiveError(
        "MISSING_BLOB",
        `blob ${row.blob_id} for ${ref.entityId}@v${ref.version} is missing`,
        { entityId: ref.entityId, version: ref.version }
      );
    }
    return {
      entityId: ref.entityId,
      version: ref.version,
      parentVersion: payload.parentVersion,
      kind: payload.kind,
      blobId: row.blob_id,
      payload,
      summary: row.summary,
      fingerprint: row.fingerprint,
      createdAt: payload.createdAt
    };
  }

  latestVersion(entityId: string): StoredVersion | null {
    const row = this.db
      .prepare("SELECT MAX(version) AS v FROM entity_versions WHERE entity_id = ?")
      .get(entityId) as { v: number | null };
    if (row.v === null) return null;
    return this.getVersion({ entityId, version: row.v, role: "latest" });
  }

  listVersions(entityId: string): Array<{ version: number; kind: string; summary: string; createdAt: number }> {
    return this.db
      .prepare("SELECT version, kind, summary, created_at FROM entity_versions WHERE entity_id = ? ORDER BY version")
      .all(entityId) as Array<{ version: number; kind: string; summary: string; created_at: number }>;
  }

  listEntities(): Array<{ entityId: string; kind: string; latest: number }> {
    return this.db
      .prepare(
        `SELECT e.entity_id AS entityId, e.kind AS kind,
                (SELECT MAX(version) FROM entity_versions v WHERE v.entity_id = e.entity_id) AS latest
         FROM entities e ORDER BY e.entity_id`
      )
      .all() as Array<{ entityId: string; kind: string; latest: number }>;
  }

  directDependents(ref: Ref): Ref[] {
    return (
      this.db
        .prepare(
          `SELECT source_entity, source_version, source_role FROM refs
           WHERE target_entity = ? AND target_version = ?`
        )
        .all(ref.entityId, ref.version) as Array<{
        source_entity: string;
        source_version: number;
        source_role: string;
      }>
    ).map((r) => ({ entityId: r.source_entity, version: r.source_version, role: r.source_role }));
  }

  transitiveDependents(ref: Ref): Ref[] {
    const out: Ref[] = [];
    const seen = new Set<string>();
    const queue: Ref[] = [ref];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const dep of this.directDependents(cur)) {
        const key = `${dep.entityId}@${dep.version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(dep);
        queue.push(dep);
      }
    }
    return out;
  }

  setPointer(name: string, ref: Ref): void {
    this.db
      .prepare(
        `INSERT INTO pointers(name, entity_id, version) VALUES(?,?,?)
         ON CONFLICT(name) DO UPDATE SET entity_id=excluded.entity_id, version=excluded.version`
      )
      .run(name, ref.entityId, ref.version);
  }

  getPointer(name: string): Ref | null {
    const row = this.db.prepare("SELECT entity_id, version FROM pointers WHERE name = ?").get(name) as
      | { entity_id: string; version: number }
      | undefined;
    return row ? { entityId: row.entity_id, version: row.version, role: name } : null;
  }

  appendEvent(event: Omit<ReviewEvent, "seq" | "eventId" | "at"> & {
    eventId?: string;
    seq?: number;
    at?: number;
  }): ReviewEvent {
    const seq = event.seq ?? ((this.db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS s FROM events").get() as { s: number }).s);
    const at = event.at ?? this.now();
    const eventId = event.eventId ?? contentId("evt", { seq, type: event.type, at, subject: event.subject, params: event.parameters });
    const payload: ReviewEvent = {
      eventId,
      seq,
      type: event.type,
      at,
      actor: event.actor,
      situation: event.situation,
      runId: event.runId,
      subject: event.subject,
      affected: event.affected,
      rationale: event.rationale,
      note: event.note,
      parameters: event.parameters
    };
    this.db
      .prepare(
        `INSERT INTO events(seq, event_id, event_type, at, actor, situation, run_id, subject_entity, subject_version, payload_json)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        seq,
        eventId,
        event.type,
        at,
        event.actor,
        event.situation,
        event.runId,
        event.subject?.entityId ?? null,
        event.subject?.version ?? null,
        stableStringify(payload)
      );
    return payload;
  }

  listEvents(opts: { runId?: string } = {}): ReviewEvent[] {
    const rows = opts.runId
      ? (this.db.prepare("SELECT payload_json FROM events WHERE run_id = ? ORDER BY seq").all(opts.runId) as Array<{ payload_json: string }>)
      : (this.db.prepare("SELECT payload_json FROM events ORDER BY seq").all() as Array<{ payload_json: string }>);
    return rows.map((r) => JSON.parse(r.payload_json) as ReviewEvent);
  }

  getEvent(seq: number): ReviewEvent | null {
    const row = this.db.prepare("SELECT payload_json FROM events WHERE seq = ?").get(seq) as
      | { payload_json: string }
      | undefined;
    return row ? (JSON.parse(row.payload_json) as ReviewEvent) : null;
  }

  putRun(run: { runId: string; situation: string; mode: string; fragmentBlobIds: string[]; note?: string; createdAt?: number }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO runs(run_id, situation, mode, created_at, fragment_blob_ids, note)
         VALUES(?,?,?,?,?,?)`
      )
      .run(
        run.runId,
        run.situation,
        run.mode,
        run.createdAt ?? this.now(),
        stableStringify(run.fragmentBlobIds),
        run.note ?? ""
      );
  }

  getRun(runId: string): { runId: string; situation: string; mode: string; fragmentBlobIds: string[]; note: string } | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as
      | { run_id: string; situation: string; mode: string; fragment_blob_ids: string; note: string }
      | undefined;
    return row
      ? {
          runId: row.run_id,
          situation: row.situation,
          mode: row.mode,
          fragmentBlobIds: JSON.parse(row.fragment_blob_ids),
          note: row.note
        }
      : null;
  }

  verifyIntegrity(): { ok: true } | { ok: false; errors: string[] } {
    const errors: string[] = [];
    const versions = this.db
      .prepare("SELECT entity_id, version, payload_json, fingerprint, blob_id FROM entity_versions")
      .all() as Array<{ entity_id: string; version: number; payload_json: string; fingerprint: string; blob_id: string }>;
    for (const v of versions) {
      if (sha256Hex(v.payload_json) !== v.fingerprint) {
        errors.push(`FINGERPRINT_MISMATCH ${v.entity_id}@v${v.version}`);
      }
      if (!this.getBlob(v.blob_id)) errors.push(`MISSING_BLOB ${v.blob_id}`);
      const payload = JSON.parse(v.payload_json) as AnyEntityVersion;
      const sources = (payload as { sources?: Ref[] }).sources ?? [];
      for (const ref of sources) {
        const hit = this.db
          .prepare("SELECT 1 FROM entity_versions WHERE entity_id = ? AND version = ?")
          .get(ref.entityId, ref.version);
        if (!hit) {
          errors.push(`MISSING_REFERENCED_VERSION ${ref.entityId}@v${ref.version} <- ${v.entity_id}@v${v.version}`);
        }
      }
    }
    const seqs = (this.db.prepare("SELECT seq FROM events ORDER BY seq").all() as Array<{ seq: number }>).map((r) => r.seq);
    seqs.forEach((s, i) => {
      if (s !== i + 1) errors.push(`EVENT_GAP expected seq ${i + 1}, got ${s}`);
    });
    return errors.length ? { ok: false, errors } : { ok: true };
  }

  allBlobs(): BlobRecord[] {
    const rows = this.db.prepare("SELECT blob_id, media_type, bytes, sha256 FROM blobs ORDER BY blob_id").all() as Array<{
      blob_id: string;
      media_type: string;
      bytes: Uint8Array;
      sha256: string;
    }>;
    return rows.map((r) => ({ blobId: r.blob_id, mediaType: r.media_type, bytes: Buffer.from(r.bytes), sha256: r.sha256 }));
  }
}
