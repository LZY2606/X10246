import { randomUUID } from "node:crypto";
import type { DB } from "../server/db.js";
import { VirtualClock } from "../shared/clock.js";
import { canonicalJson, eventSeqId, objectId, parameterFingerprint, sha256Json, shortHash } from "../shared/ids.js";
import type {
  ContentRecord,
  CorruptionReport,
  DerivedPayload,
  EventType,
  ExportBundle,
  ImportDiagnostic,
  InputKind,
  InputPayload,
  JudgmentBasis,
  LedgerEvent,
  ObjectKind,
  ObjectStatus,
  ObjectVersionRecord,
  ProjectMeta,
  QueryResult,
  RegionId,
  ScenarioId,
  VersionRef,
} from "../shared/types.js";
import { ALGORITHM_VERSIONS } from "../shared/constants.js";

export class CorruptReferenceError extends Error {
  constructor(public reports: CorruptionReport[]) {
    super(`引用损坏: ${reports.map((r) => r.code).join(", ")}`);
    this.name = "CorruptReferenceError";
  }
}

export class LockConflictError extends Error {
  constructor(public regionId: string, public existingEvent: string) {
    super(`区域 ${regionId} 已有锁定解读 ${existingEvent}，冲突需显式解决`);
    this.name = "LockConflictError";
  }
}

export interface AppendEventArgs {
  type: EventType;
  actor?: string;
  scenario?: ScenarioId;
  objectId?: string;
  version?: number;
  parentEventId?: string;
  sources?: VersionRef[];
  payload?: unknown;
  rationale?: JudgmentBasis;
}

interface Row {
  content_id: string;
  kind: string;
  payload_json: string;
  raw_json: string | null;
  diagnostics_json: string;
  created_at: string;
}

interface VRow {
  object_id: string;
  version: number;
  kind: string;
  content_id: string;
  parent_event_id: string | null;
  algorithm_version: string | null;
  parameter_fingerprint: string | null;
  sources_json: string;
  scope_regions_json: string;
  status: string;
  created_at: string;
  created_by_event: string;
  summary: string;
}

function summarize(kind: ObjectKind, payload: unknown): string {
  const p = payload as Record<string, unknown>;
  switch (kind) {
    case "wrapped_phase":
    case "amplitude":
    case "snr_score":
    case "invalid_mask": {
      const frame = p.frame as { width: number; height: number };
      return `${kind} ${frame.width}x${frame.height}`;
    }
    case "residue_map":
      return `residue_map charges=${(p.charges as unknown[]).length} unknownCells=${(p.unknownCells as unknown[]).length}`;
    case "branch_cut_network":
      return `branch_cut_network edges=${(p.edges as unknown[]).length}`;
    case "quality_map":
      return `quality_map ${p.width}x${p.height} cells=${(p.cells as unknown[]).length}`;
    case "unwrapped_tree":
      return `unwrapped_tree ${p.treeId} covered=${(p.covered as unknown[]).length}`;
    case "cycle_residuals":
      return `cycle_residuals cycles=${(p.cycles as unknown[]).length}`;
    case "unwrapped_phase": {
      const px = p.pixels as { unwrappedRad: number | null }[];
      const unknown = px.filter((q) => q.unwrappedRad === null).length;
      return `unwrapped_phase ${p.width}x${p.height} known=${px.length - unknown} unknown=${unknown}`;
    }
    case "height_field": {
      const px = p.pixels as { height: number | null }[];
      return `height_field ${p.width}x${p.height} unit=${p.unit} known=${px.filter((q) => q.height !== null).length}`;
    }
    case "candidate_set":
      return `candidate_set ${p.ambiguityId} candidates=${(p.candidates as unknown[]).length}`;
    case "wavelength":
      return `wavelength ${(p.wavelength as { value: number }).value} ${(p.wavelength as { unit: { unit: string } }).unit.unit}`;
    case "incidence_geometry":
      return `geometry ${p.arrangement} passFactor=${p.passFactor}`;
    case "calibration_plane":
      return `calibration_plane anchors=${(p.anchors as unknown[]).length} unit=${p.lengthUnit}`;
    case "cut_edit_history":
      return `cut_edit_history edits=${(p.edits as unknown[]).length}`;
  }
}

export class Ledger {
  readonly clock: VirtualClock;
  constructor(
    public db: DB,
    public projectId: string,
    opts: { clock?: VirtualClock } = {},
  ) {
    this.clock = opts.clock ?? new VirtualClock();
  }

  static initProject(db: DB, name: string, opts: { projectId?: string; clock?: VirtualClock } = {}): Ledger {
    const projectId = opts.projectId ?? `proj_${shortHash(randomUUID())}`;
    const clock = opts.clock ?? new VirtualClock();
    const meta: ProjectMeta = { projectId, name, createdAt: clock.peek(), clock: "virtual" };
    db.prepare(
      "INSERT INTO projects(project_id,name,created_at,clock) VALUES(?,?,?,?)",
    ).run(meta.projectId, meta.name, meta.createdAt, meta.clock);
    return new Ledger(db, projectId, { clock });
  }

  meta(): ProjectMeta & { casePackId?: string } {
    const row = this.db.prepare("SELECT * FROM projects WHERE project_id=?").get(this.projectId) as
      | { project_id: string; name: string; created_at: string; clock: string; case_pack_id: string | null }
      | undefined;
    if (!row) throw new Error("项目不存在");
    return { projectId: row.project_id, name: row.name, createdAt: row.created_at, clock: "virtual", casePackId: row.case_pack_id ?? undefined };
  }

  private nextSeq(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS n FROM events").get() as { n: number };
    return row.n;
  }

  appendEvent(args: AppendEventArgs): LedgerEvent {
    const seq = this.nextSeq();
    const eventId = eventSeqId(seq);
    const at = this.clock.now();
    const event: LedgerEvent = {
      eventId,
      seq,
      at,
      actor: args.actor ?? "lab-operator",
      type: args.type,
      scenario: args.scenario,
      objectId: args.objectId,
      version: args.version,
      parentEventId: args.parentEventId,
      sources: args.sources,
      payload: args.payload,
      rationale: args.rationale,
    };
    this.db
      .prepare(
        `INSERT INTO events(event_id,seq,at,actor,type,scenario,object_id,version,parent_event_id,sources_json,payload_json,rationale_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        event.eventId,
        event.seq,
        event.at,
        event.actor,
        event.type,
        event.scenario ?? null,
        event.objectId ?? null,
        event.version ?? null,
        event.parentEventId ?? null,
        event.sources ? JSON.stringify(event.sources) : null,
        event.payload !== undefined ? JSON.stringify(event.payload) : null,
        event.rationale ? JSON.stringify(event.rationale) : null,
      );
    return event;
  }

  events(opts: { includeUndone?: boolean } = {}): LedgerEvent[] {
    const rows = this.db
      .prepare(opts.includeUndone ? "SELECT * FROM events ORDER BY seq" : "SELECT * FROM events WHERE undone=0 ORDER BY seq")
      .all() as Record<string, unknown>[];
    return rows.map(rowToEvent);
  }

  event(eventId: string): LedgerEvent {
    const row = this.db.prepare("SELECT * FROM events WHERE event_id=?").get(eventId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`事件不存在: ${eventId}`);
    return rowToEvent(row);
  }

  /** 内容去重存储：同内容只存一份不可变记录。 */
  private storeContent(kind: ObjectKind, payload: unknown, raw: unknown, diagnostics: ImportDiagnostic[], at: string): ContentRecord {
    const contentId = sha256Json({ kind, payload });
    const existing = this.db.prepare("SELECT * FROM contents WHERE content_id=?").get(contentId) as Row | undefined;
    if (!existing) {
      this.db
        .prepare(
          "INSERT INTO contents(content_id,kind,payload_json,raw_json,diagnostics_json,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          contentId,
          kind,
          canonicalJson(payload),
          raw === undefined ? null : canonicalJson(raw),
          JSON.stringify(diagnostics),
          at,
        );
    }
    return { contentId, kind, payload, raw, diagnostics, createdAt: at };
  }

  content(contentId: string): ContentRecord {
    const row = this.db.prepare("SELECT * FROM contents WHERE content_id=?").get(contentId) as Row | undefined;
    if (!row) throw new CorruptReferenceError([{ code: "MISSING_CONTENT", message: `内容缺失: ${contentId}` }]);
    return {
      contentId: row.content_id,
      kind: row.kind as ObjectKind,
      payload: JSON.parse(row.payload_json),
      raw: row.raw_json ? JSON.parse(row.raw_json) : undefined,
      diagnostics: JSON.parse(row.diagnostics_json),
      createdAt: row.created_at,
    };
  }

  /**
   * 提交输入实体（不可覆盖）。相同内容是幂等的 no-op；
   * 新内容生成同 objectId 的下一版本并写 input_committed / source_data_revision 事件。
   */
  commitInput(args: {
    kind: InputKind;
    payload: InputPayload;
    raw?: unknown;
    diagnostics?: ImportDiagnostic[];
    scenario?: ScenarioId;
    actor?: string;
    channel?: string;
  }): { record: ObjectVersionRecord; event: LedgerEvent; deduped: boolean } {
    const at = this.clock.peek();
    const content = this.storeContent(args.kind, args.payload, args.raw ?? {}, args.diagnostics ?? [], at);
    const oid = objectId(args.kind, content.contentId + (args.channel ? `#${args.channel}` : ""));
    const existing = this.latestVersionRow(oid);
    if (existing && existing.content_id === content.contentId) {
      return { record: rowToVersion(existing), event: this.event(existing.created_by_event), deduped: true };
    }
    const version = existing ? existing.version + 1 : 1;
    const event = this.appendEvent({
      type: version === 1 ? "input_committed" : "source_data_revision",
      actor: args.actor,
      scenario: args.scenario,
      objectId: oid,
      version,
      parentEventId: existing?.created_by_event,
      payload: { contentId: content.contentId, summary: summarize(args.kind, args.payload), diagnostics: content.diagnostics },
    });
    if (existing) this.db.prepare("UPDATE object_versions SET status='superseded' WHERE object_id=? AND version=?").run(oid, existing.version);
    const record: ObjectVersionRecord = {
      objectId: oid,
      kind: args.kind,
      version,
      contentId: content.contentId,
      parentVersionId: existing?.created_by_event,
      sources: [],
      scopeRegions: [],
      status: "current",
      createdAt: at,
      createdByEvent: event.eventId,
      summary: summarize(args.kind, args.payload),
    };
    this.insertVersion(record);
    return { record, event, deduped: false };
  }

  /**
   * 提交派生对象。直接来源缺失（对象/版本不存在或内容缺失）→ 报损坏，绝不退回最新版。
   */
  commitDerived(args: {
    kind: ObjectKind;
    payload: DerivedPayload;
    sources: VersionRef[];
    algorithmVersion: string;
    params: unknown;
    scopeRegions?: RegionId[];
    scenario?: ScenarioId;
    actor?: string;
    rationale?: JudgmentBasis;
  }): { record: ObjectVersionRecord; event: LedgerEvent } {
    const corruption = this.checkRefs(args.sources);
    if (corruption.length) throw new CorruptReferenceError(corruption);
    const at = this.clock.peek();
    const fp = parameterFingerprint(args.params);
    const content = this.storeContent(args.kind, args.payload, { params: args.params, parameterFingerprint: fp }, [], at);
    // 派生对象的稳定身份绑定「输入来源 + 算法版本 + 参数指纹」，保证重放/导入后身份一致
    const identity = sha256Json({
      sources: args.sources,
      algorithmVersion: args.algorithmVersion,
      fp,
    });
    const oid = objectId(args.kind, identity);
    const existing = this.latestVersionRow(oid);
    if (existing && existing.content_id === content.contentId) {
      return { record: rowToVersion(existing), event: this.event(existing.created_by_event) };
    }
    const version = existing ? existing.version + 1 : 1;
    const event = this.appendEvent({
      type: "computation_completed",
      actor: args.actor,
      scenario: args.scenario,
      objectId: oid,
      version,
      parentEventId: existing?.created_by_event,
      sources: args.sources,
      payload: { contentId: content.contentId, summary: summarize(args.kind, args.payload) },
      rationale: args.rationale,
    });
    if (existing) this.db.prepare("UPDATE object_versions SET status='superseded' WHERE object_id=? AND version=?").run(oid, existing.version);
    const record: ObjectVersionRecord = {
      objectId: oid,
      kind: args.kind,
      version,
      contentId: content.contentId,
      parentVersionId: existing?.created_by_event,
      algorithmVersion: args.algorithmVersion,
      parameterFingerprint: fp,
      sources: args.sources,
      scopeRegions: args.scopeRegions ?? [],
      status: "current",
      createdAt: at,
      createdByEvent: event.eventId,
      summary: summarize(args.kind, args.payload),
    };
    this.insertVersion(record);
    return { record, event };
  }

  /* ---------------- 锁定状态机 / 人工裁定 ---------------- */

  lockRegion(args: {
    regionId: string;
    candidateId: string;
    objectId: string;
    version: number;
    treeId?: string;
    note?: string;
    scenario?: ScenarioId;
    actor?: string;
    force?: boolean; // 冲突解决必须显式 force，并产生 lock_conflict_detected 事件
  }): { lockEvent: LedgerEvent; conflictEvent?: LedgerEvent } {
    const corruption = this.checkRefs([{ objectId: args.objectId, version: args.version }]);
    if (corruption.length) throw new CorruptReferenceError(corruption);
    const active = this.db
      .prepare("SELECT * FROM locks WHERE region_id=? AND active=1")
      .get(args.regionId) as { candidate_id: string; locked_by_event: string } | undefined;
    let conflictEvent: LedgerEvent | undefined;
    if (active && active.candidate_id !== args.candidateId) {
      conflictEvent = this.appendEvent({
        type: "lock_conflict_detected",
        actor: args.actor,
        scenario: args.scenario,
        objectId: args.objectId,
        payload: {
          regionId: args.regionId,
          existingCandidate: active.candidate_id,
          incomingCandidate: args.candidateId,
          resolvedByForce: Boolean(args.force),
        },
        rationale: {
          rule: "LOCK_CONFLICT_REQUIRES_RESOLUTION",
          evidence: { existing: active.candidate_id, incoming: args.candidateId },
          accepted: Boolean(args.force),
        },
      });
      if (!args.force) throw new LockConflictError(args.regionId, active.locked_by_event);
      this.db.prepare("UPDATE locks SET active=0 WHERE region_id=? AND active=1").run(args.regionId);
    }
    const event = this.appendEvent({
      type: "local_lock",
      actor: args.actor,
      scenario: args.scenario,
      objectId: args.objectId,
      version: args.version,
      payload: { regionId: args.regionId, candidateId: args.candidateId, treeId: args.treeId, note: args.note ?? "" },
      rationale: {
        rule: "TREE_LOCAL_CONSISTENCY_WITH_CYCLE_RESIDUAL",
        evidence: { regionId: args.regionId, candidateId: args.candidateId, treeId: args.treeId },
        accepted: true,
      },
    });
    this.db
      .prepare(
        `INSERT INTO locks(region_id,candidate_id,object_id,version,tree_id,locked_at,locked_by_event,note,active)
         VALUES(?,?,?,?,?,?,?,?,1)
         ON CONFLICT(region_id,candidate_id) DO UPDATE SET object_id=excluded.object_id, version=excluded.version,
           tree_id=excluded.tree_id, locked_at=excluded.locked_at, locked_by_event=excluded.locked_by_event,
           note=excluded.note, active=1`,
      )
      .run(args.regionId, args.candidateId, args.objectId, args.version, args.treeId ?? null, event.at, event.eventId, args.note ?? null);
    return { lockEvent: event, conflictEvent };
  }

  unlockRegion(regionId: string, actor?: string, scenario?: ScenarioId): LedgerEvent {
    this.db.prepare("UPDATE locks SET active=0 WHERE region_id=? AND active=1").run(regionId);
    return this.appendEvent({ type: "local_unlock", actor, scenario, payload: { regionId } });
  }

  activeLocks(): { regionId: string; candidateId: string; objectId: string; version: number; treeId: string | null; lockedByEvent: string; note: string | null }[] {
    const rows = this.db.prepare("SELECT * FROM locks WHERE active=1 ORDER BY locked_at").all() as Record<string, unknown>[];
    return rows.map((r) => ({
      regionId: r.region_id as string,
      candidateId: r.candidate_id as string,
      objectId: r.object_id as string,
      version: r.version as number,
      treeId: r.tree_id as string | null,
      lockedByEvent: r.locked_by_event as string,
      note: r.note as string | null,
    }));
  }

  /** 采纳/拒绝整周候选：保留全部候选，仅记录裁定。 */
  decideCandidate(args: {
    candidateSetObject: VersionRef;
    candidateId: string;
    decision: "adopt" | "reject";
    rejectReason?: string;
    scenario?: ScenarioId;
    actor?: string;
  }): LedgerEvent {
    const corruption = this.checkRefs([args.candidateSetObject]);
    if (corruption.length) throw new CorruptReferenceError(corruption);
    return this.appendEvent({
      type: args.decision === "adopt" ? "candidate_adopted" : "candidate_rejected",
      actor: args.actor,
      scenario: args.scenario,
      objectId: args.candidateSetObject.objectId,
      version: args.candidateSetObject.version,
      payload: { candidateId: args.candidateId, rejectReason: args.rejectReason ?? null },
      rationale: {
        rule: "KEEP_ALL_LEGAL_INTEGER_CANDIDATES",
        evidence: { candidateId: args.candidateId, rejected: args.decision === "reject" },
        accepted: args.decision === "adopt",
      },
    });
  }

  /** 撤销：历史不可覆盖，追加 undo 事件并把上一条可撤销事件标记 undone=1（用于重放过滤）。 */
  undo(actor?: string): LedgerEvent {
    const rows = this.db.prepare("SELECT * FROM events WHERE undone=0 AND type NOT IN ('undo','redo','import_bundle','export_bundle') ORDER BY seq DESC LIMIT 1").all() as Record<string, unknown>[];
    if (!rows.length) throw new Error("没有可撤销的事件");
    const target = rows[0] as { event_id: string };
    const event = this.appendEvent({ type: "undo", actor, payload: { undoneEvent: target.event_id }, parentEventId: target.event_id });
    this.db.prepare("UPDATE events SET undone=1 WHERE event_id=?").run(target.event_id);
    return event;
  }

  recordCutEdit(args: {
    objectVersion: VersionRef;
    edit: unknown;
    scenario?: ScenarioId;
    actor?: string;
  }): LedgerEvent {
    const corruption = this.checkRefs([args.objectVersion]);
    if (corruption.length) throw new CorruptReferenceError(corruption);
    return this.appendEvent({
      type: "cut_edit_applied",
      actor: args.actor,
      scenario: args.scenario,
      objectId: args.objectVersion.objectId,
      version: args.objectVersion.version,
      payload: args.edit,
      rationale: { rule: "EXPLICIT_CUT_INTEGER_OFFSET", evidence: { edit: args.edit }, accepted: true },
    });
  }

  recordWavelengthSwitch(args: { from: VersionRef; to: VersionRef; scenario?: ScenarioId; actor?: string }): LedgerEvent {
    const corruption = this.checkRefs([args.from, args.to]);
    if (corruption.length) throw new CorruptReferenceError(corruption);
    return this.appendEvent({
      type: "wavelength_switched",
      actor: args.actor,
      scenario: args.scenario,
      sources: [args.from, args.to],
      rationale: { rule: "LOCAL_SOURCE_CHANGE_SCOPED_STALENESS", evidence: { from: args.from, to: args.to }, accepted: true },
    });
  }

  /* ---------------- 局部过期 ---------------- */

  /**
   * 局部源变化：只把直接/传递依赖 oldRef 的当前派生结果标记 stale（可限制到 scopeRegions）。
   * 过期结果仍可查看，但不能冒充当前结果。
   */
  markDependentsStale(oldRef: VersionRef, changedRegions?: RegionId[], actor?: string): number {
    const affected: string[] = [];
    const walk = (ref: VersionRef, regions: RegionId[] | null): void => {
      const rows = this.db
        .prepare("SELECT * FROM object_versions WHERE status='current'")
        .all() as VRow[];
      for (const v of rows) {
        const sources = JSON.parse(v.sources_json) as VersionRef[];
        if (!sources.some((s) => s.objectId === ref.objectId && s.version === ref.version)) continue;
        if (affected.includes(v.object_id)) continue;
        const scope = JSON.parse(v.scope_regions_json) as RegionId[];
        if (regions && scope.length && !regions.every((r) => scope.includes(r)) && !scope.some((s) => regions.includes(s))) continue;
        affected.push(v.object_id);
        this.db.prepare("UPDATE object_versions SET status='stale' WHERE object_id=? AND version=?").run(v.object_id, v.version);
        walk({ objectId: v.object_id, version: v.version }, scope.length ? scope : regions);
      }
    };
    walk(oldRef, changedRegions ?? null);
    if (affected.length) {
      this.appendEvent({
        type: "source_data_revision",
        actor,
        payload: { staleObjects: affected, changedRegions: changedRegions ?? null },
        rationale: { rule: "LOCAL_SOURCE_CHANGE_SCOPED_STALENESS", evidence: { oldRef, affected, changedRegions }, accepted: true },
      });
    }
    return affected.length;
  }

  reinstateCurrent(objectId: string, version: number) {
    this.db.prepare("UPDATE object_versions SET status='current' WHERE object_id=? AND version=? AND status='stale'").run(objectId, version);
  }

  /* ---------------- 查询 ---------------- */

  checkRefs(refs: VersionRef[]): CorruptionReport[] {
    const reports: CorruptionReport[] = [];
    for (const ref of refs) {
      if (!ref || !ref.objectId || typeof ref.version !== "number") {
        reports.push({ code: "MISSING_REFERENCE", ref, message: "引用缺少 objectId/version" });
        continue;
      }
      const row = this.db
        .prepare("SELECT * FROM object_versions WHERE object_id=? AND version=?")
        .get(ref.objectId, ref.version) as VRow | undefined;
      if (!row) {
        reports.push({ code: "DANGLING_VERSION", ref, message: `引用版本不存在: ${ref.objectId}#${ref.version}` });
        continue;
      }
      const c = this.db.prepare("SELECT 1 FROM contents WHERE content_id=?").get(row.content_id);
      if (!c) reports.push({ code: "MISSING_CONTENT", ref, message: `版本引用的内容缺失: ${row.content_id}` });
    }
    return reports;
  }

  versions(objectId?: string): ObjectVersionRecord[] {
    const rows = (objectId
      ? (this.db.prepare("SELECT * FROM object_versions WHERE object_id=? ORDER BY version").all(objectId) as VRow[])
      : (this.db.prepare("SELECT * FROM object_versions ORDER BY object_id,version").all() as VRow[]));
    return rows.map(rowToVersion);
  }

  latest(objectId: string): ObjectVersionRecord | undefined {
    const row = this.latestVersionRow(objectId);
    return row ? rowToVersion(row) : undefined;
  }

  private latestVersionRow(objectId: string): VRow | undefined {
    return this.db.prepare("SELECT * FROM object_versions WHERE object_id=? ORDER BY version DESC LIMIT 1").get(objectId) as VRow | undefined;
  }

  /** 查询任一实体：必须显式版本；缺少引用/版本损坏时报错，绝不退回最新版。 */
  query(ref: VersionRef): QueryResult {
    const reports = this.checkRefs([ref]);
    if (reports.length) throw new CorruptReferenceError(reports);
    const row = this.db.prepare("SELECT * FROM object_versions WHERE object_id=? AND version=?").get(ref.objectId, ref.version) as VRow;
    const content = this.content(row.content_id);
    return {
      objectId: row.object_id,
      version: row.version,
      kind: row.kind as ObjectKind,
      status: row.status as ObjectStatus,
      summary: row.summary,
      sources: JSON.parse(row.sources_json),
      payload: content.payload,
    };
  }

  currentByKind(kind: ObjectKind): ObjectVersionRecord[] {
    const rows = this.db.prepare("SELECT * FROM object_versions WHERE kind=? AND status='current' ORDER BY object_id").all(kind) as VRow[];
    return rows.map(rowToVersion);
  }

  /** 从对象反查完整血缘：输入内容 -> 计算版本 -> 人工事件。 */
  lineage(ref: VersionRef): { version: ObjectVersionRecord; producingEvent: LedgerEvent; content: ContentRecord } {
    const version = (this.latestVersionRow(ref.objectId) as VRow);
    if (!version || version.version !== ref.version) {
      const exact = this.db.prepare("SELECT * FROM object_versions WHERE object_id=? AND version=?").get(ref.objectId, ref.version) as VRow | undefined;
      if (!exact) throw new CorruptReferenceError([{ code: "DANGLING_VERSION", ref, message: "血缘查询版本不存在" }]);
      return { version: rowToVersion(exact), producingEvent: this.event(exact.created_by_event), content: this.content(exact.content_id) };
    }
    return { version: rowToVersion(version), producingEvent: this.event(version.created_by_event), content: this.content(version.content_id) };
  }

  private insertVersion(r: ObjectVersionRecord) {
    this.db
      .prepare(
        `INSERT INTO object_versions(object_id,version,kind,content_id,parent_event_id,algorithm_version,parameter_fingerprint,sources_json,scope_regions_json,status,created_at,created_by_event,summary)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        r.objectId,
        r.version,
        r.kind,
        r.contentId,
        r.parentVersionId ?? null,
        r.algorithmVersion ?? null,
        r.parameterFingerprint ?? null,
        JSON.stringify(r.sources),
        JSON.stringify(r.scopeRegions),
        r.status,
        r.createdAt,
        r.createdByEvent,
        r.summary,
      );
  }

  /* ---------------- 导出 / 删除库 / 再导入：身份、顺序、来源关系保持 ---------------- */

  exportBundle(casePackId?: string): ExportBundle {
    const contents = (this.db.prepare("SELECT * FROM contents ORDER BY content_id").all() as Row[]).map((r) => ({
      contentId: r.content_id,
      kind: r.kind as ObjectKind,
      payload: JSON.parse(r.payload_json),
      raw: r.raw_json ? JSON.parse(r.raw_json) : undefined,
      diagnostics: JSON.parse(r.diagnostics_json) as ImportDiagnostic[],
      createdAt: r.created_at,
    }));
    const vrows = (this.db
      .prepare("SELECT ov.* FROM object_versions ov JOIN events e ON e.event_id=ov.created_by_event ORDER BY e.seq")
      .all() as VRow[]).map(rowToVersion);
    const events = this.events({ includeUndone: true });
    const meta = this.meta();
    return {
      format: "interferometry-ledger/bundle",
      formatVersion: 1,
      project: { projectId: meta.projectId, name: meta.name, createdAt: meta.createdAt, clock: "virtual" },
      contents,
      versions: vrows,
      events,
      casePackId: casePackId ?? meta.casePackId,
    };
  }

  verifyIntegrity(): CorruptionReport[] {
    const reports: CorruptionReport[] = [];
    const versions = (this.db.prepare("SELECT * FROM object_versions").all() as VRow[]).map(rowToVersion);
    for (const v of versions) {
      reports.push(...this.checkRefs(v.sources));
      const c = this.db.prepare("SELECT 1 FROM contents WHERE content_id=?").get(v.contentId);
      if (!c) reports.push({ code: "MISSING_CONTENT", message: `对象 ${v.objectId}#${v.version} 内容缺失` });
    }
    const events = this.events({ includeUndone: true });
    for (let i = 0; i < events.length; i++) {
      if (events[i].seq !== i + 1) {
        reports.push({ code: "SEQUENCE_GAP", message: `事件序号不连续 @${i}: ${events[i].seq}` });
        break;
      }
    }
    return reports;
  }

  setCasePack(id: string) {
    this.db.prepare("UPDATE projects SET case_pack_id=? WHERE project_id=?").run(id, this.projectId);
  }
}

/* ---------------- 从导出包导入（全新临时/正式库） ---------------- */

export function importBundle(db: DB, bundle: ExportBundle, clock?: VirtualClock): Ledger {
  if (bundle.format !== "interferometry-ledger/bundle" || bundle.formatVersion !== 1)
    throw new Error("不支持的导出包格式");
  // 幂等：若项目已存在则校验身份后跳过
  const exists = db.prepare("SELECT 1 FROM projects WHERE project_id=?").get(bundle.project.projectId);
  if (exists) return new Ledger(db, bundle.project.projectId, { clock });

  db.prepare("INSERT INTO projects(project_id,name,created_at,clock,case_pack_id) VALUES(?,?,?,?,?)").run(
    bundle.project.projectId,
    bundle.project.name,
    bundle.project.createdAt,
    "virtual",
    bundle.casePackId ?? null,
  );
  const ledger = new Ledger(db, bundle.project.projectId, { clock: clock ?? new VirtualClock(undefined, 0) });

  for (const c of bundle.contents) {
    const id = sha256Json({ kind: c.kind, payload: c.payload });
    if (id !== c.contentId)
      throw new CorruptReferenceError([{ code: "CONTENT_HASH_MISMATCH", message: `内容哈希不一致: ${c.contentId}` }]);
    db.prepare(
      "INSERT OR IGNORE INTO contents(content_id,kind,payload_json,raw_json,diagnostics_json,created_at) VALUES(?,?,?,?,?,?)",
    ).run(
      c.contentId,
      c.kind,
      canonicalJson(c.payload),
      c.raw === undefined ? null : canonicalJson(c.raw),
      JSON.stringify(c.diagnostics ?? []),
      c.createdAt,
    );
  }
  // 严格按事件顺序重建版本，保持身份、顺序、来源关系
  for (const e of bundle.events) {
    db.prepare(
      `INSERT INTO events(event_id,seq,at,actor,type,scenario,object_id,version,parent_event_id,sources_json,payload_json,rationale_json,undone)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      e.eventId,
      e.seq,
      e.at,
      e.actor,
      e.type,
      e.scenario ?? null,
      e.objectId ?? null,
      e.version ?? null,
      e.parentEventId ?? null,
      e.sources ? JSON.stringify(e.sources) : null,
      e.payload !== undefined ? JSON.stringify(e.payload) : null,
      e.rationale ? JSON.stringify(e.rationale) : null,
      e.undone ? 1 : 0,
    );
  }
  for (const v of bundle.versions) {
    const reports = ledger.checkRefs(v.sources);
    if (reports.length) throw new CorruptReferenceError(reports);
    db.prepare(
      `INSERT INTO object_versions(object_id,version,kind,content_id,parent_event_id,algorithm_version,parameter_fingerprint,sources_json,scope_regions_json,status,created_at,created_by_event,summary)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      v.objectId,
      v.version,
      v.kind,
      v.contentId,
      v.parentVersionId ?? null,
      v.algorithmVersion ?? null,
      v.parameterFingerprint ?? null,
      JSON.stringify(v.sources),
      JSON.stringify(v.scopeRegions),
      v.status,
      v.createdAt,
      v.createdByEvent,
      v.summary,
    );
  }
  return ledger;
}

function rowToEvent(r: Record<string, unknown>): LedgerEvent {
  return {
    eventId: r.event_id as string,
    seq: r.seq as number,
    at: r.at as string,
    actor: r.actor as string,
    type: r.type as EventType,
    scenario: r.scenario as ScenarioId | undefined,
    objectId: (r.object_id as string) ?? undefined,
    version: (r.version as number) ?? undefined,
    parentEventId: (r.parent_event_id as string) ?? undefined,
    sources: r.sources_json ? (JSON.parse(r.sources_json as string) as VersionRef[]) : undefined,
    payload: r.payload_json ? JSON.parse(r.payload_json as string) : undefined,
    rationale: r.rationale_json ? JSON.parse(r.rationale_json as string) : undefined,
    undone: Boolean(r.undone),
  };
}

function rowToVersion(r: VRow): ObjectVersionRecord {
  return {
    objectId: r.object_id,
    version: r.version,
    kind: r.kind as ObjectKind,
    contentId: r.content_id,
    parentVersionId: r.parent_event_id ?? undefined,
    algorithmVersion: r.algorithm_version ?? undefined,
    parameterFingerprint: r.parameter_fingerprint ?? undefined,
    sources: JSON.parse(r.sources_json) as VersionRef[],
    scopeRegions: JSON.parse(r.scope_regions_json) as RegionId[],
    status: r.status as ObjectStatus,
    createdAt: r.created_at,
    createdByEvent: r.created_by_event,
    summary: r.summary,
  };
}

export { ALGORITHM_VERSIONS };
