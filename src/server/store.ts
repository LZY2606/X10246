import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Region, regionsOverlap } from '../domain/grid.js';
import {
  DEFAULT_UNWRAP_PARAMS,
  UnwrapCandidate,
  UnwrapParams,
  generateCandidates,
  UNWRAP_ALGORITHM_VERSION,
} from '../domain/unwrap.js';
import {
  CalibrationPlane,
  HeightResult,
  IncidenceGeometry,
  WavelengthSpec,
  computeHeight,
  HEIGHT_ALGORITHM_VERSION,
} from '../domain/height.js';
import { openDatabase } from './db.js';

export class FormatError extends Error {
  constructor(public diagnostics: string[]) {
    super(diagnostics.join('; '));
    this.name = 'FormatError';
  }
}

export class ImmutableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImmutableError';
  }
}

export class CorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptionError';
  }
}

export interface Clock {
  now(): number;
}

export class VirtualClock implements Clock {
  constructor(public t = 1_760_000_000_000) {}
  now(): number {
    this.t += 1000;
    return this.t;
  }
}

export const INPUT_KINDS = [
  'wrapped_phase',
  'quality_map',
  'invalid_mask',
  'wavelength',
  'incidence_geometry',
  'calibration_plane',
  'cut_edit_history',
] as const;

export type InputKind = (typeof INPUT_KINDS)[number];

export interface SourceRef {
  entityId: string;
  versionNo: number;
}

interface InputVersionRow {
  entity_id: string;
  version_no: number;
  parent_version_no: number | null;
  kind: InputKind;
  blob_id: string;
  meta: string;
  created_seq: number;
}

export function hashContent(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 16);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

export function fingerprintParams(value: unknown): string {
  return `pfp:${hashContent(value)}`;
}

function validateGrid(content: any, name: string, rangeCheck?: (v: number) => boolean): string[] {
  const errors: string[] = [];
  if (typeof content !== 'object' || content === null) {
    errors.push(`${name}: content must be an object`);
    return errors;
  }
  const { width, height, data } = content;
  if (!Number.isInteger(width) || width <= 0) errors.push(`${name}: width must be positive integer`);
  if (!Number.isInteger(height) || height <= 0) errors.push(`${name}: height must be positive integer`);
  if (!Array.isArray(data)) {
    errors.push(`${name}: data must be an array`);
  } else if (width * height !== data.length) {
    errors.push(`${name}: data length ${data.length} != width*height ${width * height}`);
  } else {
    data.forEach((v: unknown, i: number) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        errors.push(`${name}: data[${i}] is not a finite number`);
      } else if (rangeCheck && !rangeCheck(v)) {
        errors.push(`${name}: data[${i}] = ${v} out of allowed range`);
      }
    });
  }
  return errors;
}

export function validateInputKind(kind: InputKind, content: unknown): string[] {
  switch (kind) {
    case 'wrapped_phase':
      return validateGrid(content, 'wrapped_phase', (v) => v >= -Math.PI - 1e-9 && v <= Math.PI + 1e-9);
    case 'quality_map':
      return validateGrid(content, 'quality_map', (v) => v >= 0 && v <= 1);
    case 'invalid_mask':
      return validateGrid(content, 'invalid_mask', (v) => v === 0 || v === 1);
    case 'wavelength': {
      const errors: string[] = [];
      const w = content as any;
      if (typeof w?.wavelength?.value !== 'number' || w.wavelength.value <= 0)
        errors.push('wavelength.wavelength.value must be positive number');
      if (w?.wavelength?.unit !== 'nm') errors.push('wavelength.wavelength.unit must be "nm"');
      return errors;
    }
    case 'incidence_geometry': {
      const errors: string[] = [];
      const g = content as any;
      if (typeof g?.angle?.value !== 'number') errors.push('incidence_geometry.angle.value must be number');
      if (!['deg', 'rad'].includes(g?.angle?.unit))
        errors.push('incidence_geometry.angle.unit must be deg|rad');
      if (g?.passFactor !== 1 && g?.passFactor !== 2) errors.push('incidence_geometry.passFactor must be 1|2');
      if (typeof g?.frame !== 'string' || g.frame.length === 0)
        errors.push('incidence_geometry.frame must be non-empty string');
      return errors;
    }
    case 'calibration_plane': {
      const errors: string[] = [];
      const p = content as any;
      for (const k of ['a', 'b', 'c'])
        if (typeof p?.[k] !== 'number') errors.push(`calibration_plane.${k} must be number`);
      if (p?.unit !== 'nm') errors.push('calibration_plane.unit must be "nm"');
      if (typeof p?.frame !== 'string' || p.frame.length === 0)
        errors.push('calibration_plane.frame must be non-empty string');
      return errors;
    }
    case 'cut_edit_history': {
      const errors: string[] = [];
      const c = content as any;
      if (!Array.isArray(c?.edits)) errors.push('cut_edit_history.edits must be an array');
      else
        c.edits.forEach((e: any, i: number) => {
          if (!Number.isInteger(e?.x) || !Number.isInteger(e?.y) || !['h', 'v'].includes(e?.dir))
            errors.push(`cut_edit_history.edits[${i}] must have integer x,y and dir h|v`);
          if (!['add', 'remove'].includes(e?.action))
            errors.push(`cut_edit_history.edits[${i}].action must be add|remove`);
          if (!Number.isInteger(e?.kOffset)) errors.push(`cut_edit_history.edits[${i}].kOffset must be integer`);
        });
      return errors;
    }
  }
}

export interface CommitInputArgs {
  kind: InputKind;
  entityId?: string;
  content: unknown;
  meta?: { region?: Region; units?: string; note?: string; source?: string };
  actor?: string;
}

export interface CommitInputResult {
  entityId: string;
  versionNo: number;
  parentVersionNo: number | null;
  blobId: string;
  digest: string;
  eventId: string;
  staleResultIds: string[];
}

export class Store {
  readonly db: DatabaseSync;
  private seq = 0;
  constructor(
    dbOrPath: DatabaseSync | string,
    private clock: Clock = { now: () => Date.now() },
  ) {
    this.db = typeof dbOrPath === 'string' ? openDatabase(dbOrPath) : dbOrPath;
    const row = this.db.prepare(`SELECT MAX(seq) AS m FROM events`).get() as { m: number | null };
    this.seq = row.m ?? 0;
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** 追加一条机器可读事件。 */
  appendEvent(type: string, payload: Record<string, unknown>, actor = 'reviewer'): {
    eventId: string;
    seq: number;
  } {
    const seq = this.nextSeq();
    const eventId = `evt-${String(seq).padStart(6, '0')}`;
    this.db
      .prepare(`INSERT INTO events (event_id, seq, type, payload) VALUES (?,?,?,?)`)
      .run(eventId, seq, type, canonicalJson({ eventId, seq, type, actor, at: this.clock.now(), ...payload }));
    return { eventId, seq };
  }

  private setResultStatus(resultId: string, status: string, seq: number): void {
    this.db.prepare(`UPDATE results SET status = ? WHERE result_id = ?`).run(status, resultId);
    this.db
      .prepare(`INSERT INTO result_history (result_id, seq, status) VALUES (?,?,?)`)
      .run(resultId, seq, status);
  }

  private putBlob(content: unknown): string {
    const blobId = `sha256:${hashContent(content)}`;
    this.db.prepare(`INSERT OR IGNORE INTO blobs (blob_id, content) VALUES (?,?)`).run(
      blobId,
      typeof content === 'string' ? content : canonicalJson(content),
    );
    return blobId;
  }

  private getBlob(blobId: string): string | undefined {
    const row = this.db.prepare(`SELECT content FROM blobs WHERE blob_id = ?`).get(blobId) as
      | { content: string }
      | undefined;
    return row?.content;
  }

  /**
   * 提交原始输入。原始内容一经提交不可覆盖；修订以新版本+父版本表达。
   * 相同内容只存一份（按内容哈希去重，支撑最小/组合输入共享原始片段）。
   */
  commitInput(args: CommitInputArgs): CommitInputResult {
    const errors = validateInputKind(args.kind, args.content);
    if (errors.length) throw new FormatError(errors);

    const entityId = args.entityId ?? `ent-${args.kind}-${this.seq + 1}`;
    const latest = this.db
      .prepare(
        `SELECT version_no FROM input_versions WHERE entity_id = ? ORDER BY version_no DESC LIMIT 1`,
      )
      .get(entityId) as { version_no: number } | undefined;

    // 显式拒绝覆盖：已存在实体的同版本重写属于破坏不可变性。
    if (latest) {
      const dup = this.db
        .prepare(
          `SELECT version_no FROM input_versions iv JOIN blobs b ON iv.blob_id = b.blob_id
           WHERE iv.entity_id = ? AND b.content = ? ORDER BY iv.version_no DESC LIMIT 1`,
        )
        .get(entityId, typeof args.content === 'string' ? args.content : canonicalJson(args.content)) as
        | { version_no: number }
        | undefined;
      if (dup) {
        throw new ImmutableError(
          `entity ${entityId} version ${dup.version_no} already holds identical immutable content`,
        );
      }
    }

    const versionNo = latest ? latest.version_no + 1 : 1;
    const parentVersionNo = latest ? latest.version_no : null;
    const blobId = this.putBlob(args.content);
    const meta = {
      units: (args.meta?.units as string) ?? null,
      region: (args.meta?.region as Region) ?? null,
      note: (args.meta?.note as string) ?? null,
      source: (args.meta?.source as string) ?? null,
    };
    const seq = this.nextSeq();
    const eventId = `evt-${String(seq).padStart(6, '0')}`;
    this.db
      .prepare(
        `INSERT INTO input_versions (entity_id, version_no, parent_version_no, kind, blob_id, meta, created_seq)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(entityId, versionNo, parentVersionNo, args.kind, blobId, canonicalJson(meta), seq);
    this.db
      .prepare(
        `INSERT INTO events (event_id, seq, type, payload) VALUES (?,?,?,?)`,
      )
      .run(
        eventId,
        seq,
        'input.committed',
        canonicalJson({
          eventId,
          seq,
          type: 'input.committed',
          actor: args.actor ?? 'lab-import',
          at: this.clock.now(),
          entityId,
          kind: args.kind,
          versionNo,
          parentVersionNo,
          digest: blobId,
          region: meta.region,
          immutable: true,
        }),
      );

    const staleResultIds = this.propagateStaleness(entityId, versionNo, meta.region);
    return { entityId, versionNo, parentVersionNo, blobId, digest: blobId, eventId, staleResultIds };
  }

  /** 局部输入变化只使依赖它且区域重叠的结果过期；过期结果仍可查看但不能冒充当前。 */
  private propagateStaleness(entityId: string, newVersion: number, region: Region | null): string[] {
    const rows = this.db.prepare(`SELECT result_id, source_refs, region, status FROM results`).all() as Array<{
      result_id: string;
      source_refs: string;
      region: string | null;
      status: string;
    }>;
    const stale: string[] = [];
    for (const row of rows) {
      if (row.status === 'stale') continue;
      const refs = JSON.parse(row.source_refs) as SourceRef[];
      const ref = refs.find((r) => r.entityId === entityId && r.versionNo < newVersion);
      if (!ref) continue;
      if (region && row.region) {
        const r = JSON.parse(row.region) as Region;
        if (!regionsOverlap(r, region)) continue;
      }
      stale.push(row.result_id);
    }
    for (const resultId of stale) {
      const { seq } = this.appendEvent('result.staled', {
        resultId,
        because: { entityId, newVersion },
        note: 'expired by local source revision; still viewable, not current',
      });
      this.db
        .prepare(`UPDATE results SET status = 'stale' WHERE result_id = ?`)
        .run(resultId);
      this.db
        .prepare(`INSERT INTO result_history (result_id, seq, status) VALUES (?,?,?)`)
        .run(resultId, seq, 'stale');
    }
    return stale;
  }

  /** 查询实体：返回引用的版本号与内容摘要；缺少引用必须报损坏。 */
  getEntityVersion(entityId: string, versionNo?: number): {
    entityId: string;
    versionNo: number;
    parentVersionNo: number | null;
    kind: InputKind;
    digest: string;
    meta: Record<string, unknown>;
    content: unknown;
    createdSeq: number;
  } {
    let row: InputVersionRow | undefined;
    if (versionNo !== undefined) {
      row = this.db
        .prepare(`SELECT * FROM input_versions WHERE entity_id = ? AND version_no = ?`)
        .get(entityId, versionNo) as InputVersionRow | undefined;
      if (!row) {
        throw new CorruptionError(`missing reference ${entityId}@v${versionNo}; refusing to fall back to latest`);
      }
    } else {
      row = this.db
        .prepare(`SELECT * FROM input_versions WHERE entity_id = ? ORDER BY version_no DESC LIMIT 1`)
        .get(entityId) as InputVersionRow | undefined;
      if (!row) throw new CorruptionError(`entity ${entityId} not found`);
    }
    const content = this.getBlob(row.blob_id);
    if (content === undefined) {
      throw new CorruptionError(`blob ${row.blob_id} for ${entityId}@v${row.version_no} is missing`);
    }
    return {
      entityId: row.entity_id,
      versionNo: row.version_no,
      parentVersionNo: row.parent_version_no,
      kind: row.kind,
      digest: row.blob_id,
      meta: JSON.parse(row.meta),
      content: JSON.parse(content),
      createdSeq: row.created_seq,
    };
  }

  listEntities(): Array<{
    entityId: string;
    kind: InputKind;
    versions: Array<{ versionNo: number; parentVersionNo: number | null; digest: string; createdSeq: number }>;
  }> {
    const rows = this.db
      .prepare(`SELECT * FROM input_versions ORDER BY entity_id, version_no`)
      .all() as unknown as InputVersionRow[];
    const map = new Map<string, { entityId: string; kind: InputKind; versions: any[] }>();
    for (const r of rows) {
      if (!map.has(r.entity_id)) map.set(r.entity_id, { entityId: r.entity_id, kind: r.kind, versions: [] });
      map.get(r.entity_id)!.versions.push({
        versionNo: r.version_no,
        parentVersionNo: r.parent_version_no,
        digest: r.blob_id,
        createdSeq: r.created_seq,
      });
    }
    return [...map.values()];
  }

  private storeResult(args: {
    kind: string;
    content: unknown;
    algorithmVersion: string;
    paramFingerprint: string;
    sourceRefs: SourceRef[];
    region?: Region | null;
    diagnosis?: string | null;
  }): string {
    const seq = this.nextSeq();
    const resultId = `res-${String(seq).padStart(6, '0')}`;
    const blobId = this.putBlob(args.content);
    this.db
      .prepare(
        `INSERT INTO results (result_id, kind, status, algorithm_version, param_fingerprint, source_refs, region, blob_id, diagnosis, created_seq)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        resultId,
        args.kind,
        'current',
        args.algorithmVersion,
        args.paramFingerprint,
        canonicalJson(args.sourceRefs),
        args.region ? canonicalJson(args.region) : null,
        blobId,
        args.diagnosis ?? null,
        seq,
      );
    this.db
      .prepare(`INSERT INTO result_history (result_id, seq, status) VALUES (?,?,?)`)
      .run(resultId, seq, 'current');
    return resultId;
  }

  /** 生成整周候选：全部合法候选都保留，含路径指纹与循环残差。 */
  runUnwrap(args: {
    refs: { wrappedPhase: SourceRef; quality: SourceRef; invalidMask: SourceRef };
    params?: Partial<UnwrapParams>;
    actor?: string;
  }): { candidateIds: string[]; eventIds: string[] } {
    const phase = this.getEntityVersion(args.refs.wrappedPhase.entityId, args.refs.wrappedPhase.versionNo);
    const quality = this.getEntityVersion(args.refs.quality.entityId, args.refs.quality.versionNo);
    const mask = this.getEntityVersion(args.refs.invalidMask.entityId, args.refs.invalidMask.versionNo);
    const params: UnwrapParams = { ...DEFAULT_UNWRAP_PARAMS, ...(args.params ?? {}) };
    const candidates = generateCandidates(
      { wrappedPhase: phase.content as any, quality: quality.content as any, invalidMask: mask.content as any },
      params,
    );
    const paramFingerprint = fingerprintParams(params);
    const candidateIds: string[] = [];
    const eventIds: string[] = [];
    for (const c of candidates) {
      const resultId = this.storeResult({
        kind: 'unwrap_candidate',
        content: c,
        algorithmVersion: UNWRAP_ALGORITHM_VERSION,
        paramFingerprint,
        sourceRefs: [args.refs.wrappedPhase, args.refs.quality, args.refs.invalidMask],
        region: params.region ?? null,
        diagnosis: c.consistent ? null : `cycle-non-closure:${c.cycles.length}`,
      });
      candidateIds.push(resultId);
      const { eventId } = this.appendEvent(
        'unwrap.candidate.generated',
        {
          resultId,
          algorithmVersion: UNWRAP_ALGORITHM_VERSION,
          paramFingerprint,
          pathHash: c.pathHash,
          componentCount: c.componentCount,
          unknownCellCount: c.unknownCells.length,
          cutCount: c.cuts.length,
          cycleResidualCount: c.cycles.length,
          consistent: c.consistent,
          sourceRefs: [args.refs.wrappedPhase, args.refs.quality, args.refs.invalidMask],
          rule: 'low-amplitude-no-guess; explicit-cut-offsets; keep-path-and-cycle-residuals',
        },
        args.actor,
      );
      eventIds.push(eventId);
    }
    return { candidateIds, eventIds };
  }

  /** 高度转换链：展开相位 → 波长/几何缩放 → 标定面修正。 */
  runHeight(args: {
    candidateResultId: string;
    refs: { wavelength: SourceRef; incidenceGeometry: SourceRef; calibrationPlane: SourceRef };
    actor?: string;
  }): { resultId: string; eventId: string } {
    const candidate = this.getResult(args.candidateResultId);
    if (candidate.kind !== 'unwrap_candidate') {
      throw new FormatError([`result ${args.candidateResultId} is ${candidate.kind}, expected unwrap_candidate`]);
    }
    const wl = this.resolveRef(args.refs.wavelength);
    const geo = this.resolveRef(args.refs.incidenceGeometry);
    const cal = this.resolveRef(args.refs.calibrationPlane);
    const candContent = candidate.content as { unwrapped: (number | null)[]; params: { region?: Region } };
    const width = (phaseGridOf(this, args.candidateResultId)).width;
    const height = (phaseGridOf(this, args.candidateResultId)).height;
    const result: HeightResult = computeHeight(
      candContent.unwrapped,
      { width, height, data: [] },
      wl.content as WavelengthSpec,
      geo.content as IncidenceGeometry,
      cal.content as CalibrationPlane,
      {
        unwrapRef: { entityId: args.candidateResultId, versionNo: 1 },
        wavelengthRef: args.refs.wavelength,
        geometryRef: args.refs.incidenceGeometry,
        calibrationRef: args.refs.calibrationPlane,
      },
    );
    const sourceRefs: SourceRef[] = [
      { entityId: args.candidateResultId, versionNo: 1 },
      args.refs.wavelength,
      args.refs.incidenceGeometry,
      args.refs.calibrationPlane,
    ];
    const paramFingerprint = fingerprintParams({
      wavelength: wl.content,
      geometry: geo.content,
      calibration: cal.content,
    });
    const resultId = this.storeResult({
      kind: 'height_map',
      content: {
        heightNm: result.heightNm,
        unit: 'nm',
        frame: (geo.content as IncidenceGeometry).frame,
        steps: result.steps,
        diagnostics: result.diagnostics,
      },
      algorithmVersion: HEIGHT_ALGORITHM_VERSION,
      paramFingerprint,
      sourceRefs,
      region: candContent.params.region ?? null,
      diagnosis: result.diagnostics.length ? result.diagnostics.join('; ') : null,
    });
    const { eventId } = this.appendEvent(
      'height.chain.computed',
      {
        resultId,
        candidateResultId: args.candidateResultId,
        algorithmVersion: HEIGHT_ALGORITHM_VERSION,
        paramFingerprint,
        steps: result.steps,
        diagnostics: result.diagnostics,
        sourceRefs,
      },
      args.actor,
    );
    return { resultId, eventId };
  }

  getResult(resultId: string): {
    resultId: string;
    kind: string;
    status: string;
    algorithmVersion: string;
    paramFingerprint: string;
    sourceRefs: SourceRef[];
    region: Region | null;
    content: unknown;
    diagnosis: string | null;
    createdSeq: number;
  } {
    const row = this.db.prepare(`SELECT * FROM results WHERE result_id = ?`).get(resultId) as
      | ResultRow
      | undefined;
    if (!row) throw new CorruptionError(`result ${resultId} not found`);
    const content = this.getBlob(row.blob_id);
    if (content === undefined) throw new CorruptionError(`blob ${row.blob_id} for ${resultId} missing`);
    // 校验每个直接来源仍可解析；缺引用必须报损坏。
    const refs = JSON.parse(row.source_refs) as SourceRef[];
    for (const ref of refs) {
      if (ref.entityId.startsWith('res-')) {
        const exists = this.db.prepare(`SELECT 1 FROM results WHERE result_id = ?`).get(ref.entityId);
        if (!exists) throw new CorruptionError(`result ${resultId} references missing result ${ref.entityId}`);
      } else {
        this.resolveRef(ref);
      }
    }
    return {
      resultId: row.result_id,
      kind: row.kind,
      status: row.status,
      algorithmVersion: row.algorithm_version,
      paramFingerprint: row.param_fingerprint,
      sourceRefs: refs,
      region: row.region ? (JSON.parse(row.region) as Region) : null,
      content: JSON.parse(content),
      diagnosis: row.diagnosis,
      createdSeq: row.created_seq,
    };
  }

  listResults(filter?: { kind?: string; status?: string }) {
    const rows = this.db.prepare(`SELECT * FROM results ORDER BY created_seq`).all() as unknown as ResultRow[];
    return rows
      .filter((r) => (!filter?.kind || r.kind === filter.kind) && (!filter?.status || r.status === filter.status))
      .map((r) => ({
        resultId: r.result_id,
        kind: r.kind,
        status: r.status,
        algorithmVersion: r.algorithm_version,
        paramFingerprint: r.param_fingerprint,
        sourceRefs: JSON.parse(r.source_refs) as SourceRef[],
        region: r.region ? JSON.parse(r.region) : null,
        diagnosis: r.diagnosis,
        createdSeq: r.created_seq,
      }));
  }

  /** 人工决定：接受/否定/参数调整/解决冲突。决定与撤销都写入历史。 */
  decide(args: {
    resultId: string;
    action: 'accept' | 'reject' | 'adjust' | 'resolve_conflict';
    reason: string;
    actor?: string;
    payload?: Record<string, unknown>;
  }): { decisionId: string; eventId: string } {
    const row = this.db.prepare(`SELECT status FROM results WHERE result_id = ?`).get(args.resultId) as
      | { status: string }
      | undefined;
    if (!row) throw new CorruptionError(`result ${args.resultId} not found`);
    const seq = this.nextSeq();
    const decisionId = `dec-${String(seq).padStart(6, '0')}`;
    this.db
      .prepare(`INSERT INTO decisions (decision_id, result_id, action, payload, created_seq) VALUES (?,?,?,?,?)`)
      .run(
        decisionId,
        args.resultId,
        args.action,
        canonicalJson({ reason: args.reason, ...(args.payload ?? {}) }),
        seq,
      );
    let newStatus: string | null = null;
    if (args.action === 'accept') newStatus = 'accepted';
    if (args.action === 'reject') newStatus = 'rejected';
    const { eventId, seq: eventSeq } = this.appendEvent(
      `decision.${args.action}`,
      {
        decisionId,
        resultId: args.resultId,
        action: args.action,
        reason: args.reason,
        payload: args.payload ?? {},
        previousStatus: row.status,
        newStatus,
      },
      args.actor,
    );
    if (newStatus) this.setResultStatus(args.resultId, newStatus, eventSeq);
    return { decisionId, eventId };
  }

  /** 撤销决定：写一条反向事件，而不是删除历史。 */
  undoDecision(decisionId: string, actor?: string): { eventId: string } {
    const row = this.db
      .prepare(`SELECT result_id, action FROM decisions WHERE decision_id = ?`)
      .get(decisionId) as { result_id: string | null; action: string } | undefined;
    if (!row) throw new CorruptionError(`decision ${decisionId} not found`);
    const { eventId, seq: eventSeq } = this.appendEvent(
      'decision.undone',
      { decisionId, resultId: row.result_id, action: row.action, note: 'undo recorded as new event; history kept' },
      actor,
    );
    if (row.result_id && (row.action === 'accept' || row.action === 'reject')) {
      this.setResultStatus(row.result_id, 'current', eventSeq);
    }
    return { eventId };
  }

  /** 局部锁定：同一区域、同一来源候选的冲突锁定要显式冲突，而不是互相覆盖。 */
  lockLocal(args: {
    resultId: string;
    region: Region;
    kOffsets: Record<string, number>;
    actor?: string;
  }): { lockId: string; conflict: boolean; eventId: string } {
    const result = this.getResult(args.resultId);
    if (result.kind !== 'unwrap_candidate') {
      throw new FormatError([`lock target must be an unwrap_candidate, got ${result.kind}`]);
    }
    const active = this.db
      .prepare(`SELECT lock_id, region, k_offsets, basis_result_id FROM locks WHERE status = 'active'`)
      .all() as Array<{ lock_id: string; region: string; k_offsets: string; basis_result_id: string | null }>;
    let conflict = false;
    let conflictWith: string | null = null;
    for (const l of active) {
      const lr = JSON.parse(l.region) as Region;
      if (!regionsOverlap(lr, args.region)) continue;
      const lk = JSON.parse(l.k_offsets) as Record<string, number>;
      for (const [key, v] of Object.entries(args.kOffsets)) {
        if (lk[key] !== undefined && lk[key] !== v) {
          conflict = true;
          conflictWith = l.lock_id;
          break;
        }
      }
      if (conflict) break;
    }
    const seq = this.nextSeq();
    const lockId = `lock-${String(seq).padStart(6, '0')}`;
    const status = conflict ? 'conflicted' : 'active';
    this.db
      .prepare(
        `INSERT INTO locks (lock_id, region, k_offsets, basis_result_id, status, created_seq) VALUES (?,?,?,?,?,?)`,
      )
      .run(lockId, canonicalJson(args.region), canonicalJson(args.kOffsets), args.resultId, status, seq);
    this.db.prepare(`INSERT INTO lock_history (lock_id, seq, status) VALUES (?,?,?)`).run(lockId, seq, status);
    const { eventId } = this.appendEvent(
      conflict ? 'lock.conflict' : 'lock.created',
      {
        lockId,
        resultId: args.resultId,
        region: args.region,
        kOffsets: args.kOffsets,
        conflictWith,
        rule: 'local-lock-conflict: overlapping locks with different integer offsets must conflict explicitly',
      },
      args.actor,
    );
    return { lockId, conflict, eventId };
  }

  resolveLockConflict(args: {
    keepLockId: string;
    dropLockId: string;
    reason: string;
    actor?: string;
  }): { eventId: string } {
    for (const id of [args.keepLockId, args.dropLockId]) {
      const row = this.db.prepare(`SELECT status FROM locks WHERE lock_id = ?`).get(id) as
        | { status: string }
        | undefined;
      if (!row) throw new CorruptionError(`lock ${id} not found`);
    }
    const seq = this.nextSeq();
    this.db.prepare(`UPDATE locks SET status = 'released' WHERE lock_id = ?`).run(args.dropLockId);
    this.db.prepare(`INSERT INTO lock_history (lock_id, seq, status) VALUES (?,?,?)`).run(args.dropLockId, seq, 'released');
    this.db.prepare(`UPDATE locks SET status = 'active' WHERE lock_id = ?`).run(args.keepLockId);
    this.db.prepare(`INSERT INTO lock_history (lock_id, seq, status) VALUES (?,?,?)`).run(args.keepLockId, seq, 'active');
    return this.appendEvent(
      'lock.conflict.resolved',
      { keepLockId: args.keepLockId, dropLockId: args.dropLockId, reason: args.reason },
      args.actor,
    );
  }

  listLocks() {
    const rows = this.db.prepare(`SELECT * FROM locks ORDER BY created_seq`).all() as Array<{
      lock_id: string;
      region: string;
      k_offsets: string;
      basis_result_id: string | null;
      status: string;
      created_seq: number;
    }>;
    return rows.map((r) => ({
      lockId: r.lock_id,
      region: JSON.parse(r.region),
      kOffsets: JSON.parse(r.k_offsets),
      basisResultId: r.basis_result_id,
      status: r.status,
      createdSeq: r.created_seq,
    }));
  }

  listEvents(sinceSeq = 0) {
    const rows = this.db
      .prepare(`SELECT event_id, seq, type, payload FROM events WHERE seq > ? ORDER BY seq`)
      .all(sinceSeq) as Array<{ event_id: string; seq: number; type: string; payload: string }>;
    return rows.map((r) => ({ eventId: r.event_id, seq: r.seq, type: r.type, payload: JSON.parse(r.payload) }));
  }

  /** 回到任意旧事件：恢复当时的依赖版本与可见结论，而不是用最新结果覆盖历史。 */
  stateAt(seq: number): {
    seq: number;
    results: Array<{ resultId: string; kind: string; status: string; createdSeq: number }>;
    locks: Array<{ lockId: string; status: string }>;
    events: Array<{ eventId: string; seq: number; type: string }>;
  } {
    const resultRows = this.db
      .prepare(
        `SELECT r.result_id, r.kind, r.created_seq,
                (SELECT status FROM result_history h WHERE h.result_id = r.result_id AND h.seq <= ?
                 ORDER BY h.seq DESC LIMIT 1) AS status
         FROM results r WHERE r.created_seq <= ? ORDER BY r.created_seq`,
      )
      .all(seq, seq) as Array<{ result_id: string; kind: string; created_seq: number; status: string | null }>;
    const lockRows = this.db
      .prepare(
        `SELECT l.lock_id,
                (SELECT status FROM lock_history h WHERE h.lock_id = l.lock_id AND h.seq <= ?
                 ORDER BY h.seq DESC LIMIT 1) AS status
         FROM locks l WHERE l.created_seq <= ?`,
      )
      .all(seq, seq) as Array<{ lock_id: string; status: string | null }>;
    const eventRows = this.db
      .prepare(`SELECT event_id, seq, type FROM events WHERE seq <= ? ORDER BY seq`)
      .all(seq) as Array<{ event_id: string; seq: number; type: string }>;
    return {
      seq,
      results: resultRows.map((r) => ({
        resultId: r.result_id,
        kind: r.kind,
        status: r.status ?? 'current',
        createdSeq: r.created_seq,
      })),
      locks: lockRows.map((l) => ({ lockId: l.lock_id, status: l.status ?? 'active' })),
      events: eventRows.map((e) => ({ eventId: e.event_id, seq: e.seq, type: e.type })),
    };
  }

  /** 严格解析来源引用：缺失即损坏，绝不退回最新版。 */
  resolveRef(ref: SourceRef): { content: unknown; meta: Record<string, unknown>; kind: InputKind; blobId: string } {
    const v = this.getEntityVersion(ref.entityId, ref.versionNo);
    return { content: v.content, meta: v.meta, kind: v.kind, blobId: v.digest };
  }

  /** 导出：完整快照，身份、顺序、来源关系全部保留。 */
  exportDump(): ExportDump {
    const q = (sql: string) => this.db.prepare(sql).all() as Record<string, unknown>[];
    return {
      format: 'interference-book/export',
      formatVersion: 1,
      tables: {
        blobs: q(`SELECT * FROM blobs ORDER BY blob_id`),
        input_versions: q(`SELECT * FROM input_versions ORDER BY entity_id, version_no`),
        events: q(`SELECT * FROM events ORDER BY seq`),
        results: q(`SELECT * FROM results ORDER BY created_seq`),
        result_history: q(`SELECT * FROM result_history ORDER BY result_id, seq`),
        decisions: q(`SELECT * FROM decisions ORDER BY created_seq`),
        locks: q(`SELECT * FROM locks ORDER BY created_seq`),
        lock_history: q(`SELECT * FROM lock_history ORDER BY lock_id, seq`),
      },
    };
  }

  /** 导入：校验内容哈希与引用完整性后按原身份写入；数据库应为空库。 */
  importDump(dump: ExportDump): { imported: Record<string, number> } {
    if (dump.format !== 'interference-book/export') {
      throw new FormatError([`unknown export format: ${(dump as any).format}`]);
    }
    const count = (this.db.prepare(`SELECT COUNT(*) AS c FROM events`).get() as { c: number }).c;
    if (count > 0) throw new ImmutableError('import requires an empty database; refusing to merge over history');

    for (const blob of dump.tables.blobs as Array<{ blob_id: string; content: string }>) {
      const actual = `sha256:${hashContent(JSON.parse(blob.content))}`;
      if (actual !== blob.blob_id) {
        throw new CorruptionError(`blob ${blob.blob_id} content hash mismatch (got ${actual})`);
      }
    }

    const tx = (fn: () => void) => {
      this.db.exec('BEGIN');
      try {
        fn();
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    };
    tx(() => {
      const ins = (sql: string) => this.db.prepare(sql);
      const b = ins(`INSERT INTO blobs (blob_id, content) VALUES (?,?)`);
      for (const r of dump.tables.blobs as any[]) b.run(r.blob_id, r.content);
      const iv = ins(
        `INSERT INTO input_versions (entity_id, version_no, parent_version_no, kind, blob_id, meta, created_seq)
         VALUES (?,?,?,?,?,?,?)`,
      );
      for (const r of dump.tables.input_versions as any[])
        iv.run(r.entity_id, r.version_no, r.parent_version_no, r.kind, r.blob_id, r.meta, r.created_seq);
      const ev = ins(`INSERT INTO events (event_id, seq, type, payload) VALUES (?,?,?,?)`);
      for (const r of dump.tables.events as any[]) ev.run(r.event_id, r.seq, r.type, r.payload);
      const rs = ins(
        `INSERT INTO results (result_id, kind, status, algorithm_version, param_fingerprint, source_refs, region, blob_id, diagnosis, created_seq)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const r of dump.tables.results as any[])
        rs.run(
          r.result_id, r.kind, r.status, r.algorithm_version, r.param_fingerprint,
          r.source_refs, r.region, r.blob_id, r.diagnosis, r.created_seq,
        );
      const rh = ins(`INSERT INTO result_history (result_id, seq, status) VALUES (?,?,?)`);
      for (const r of dump.tables.result_history as any[]) rh.run(r.result_id, r.seq, r.status);
      const dc = ins(`INSERT INTO decisions (decision_id, result_id, action, payload, created_seq) VALUES (?,?,?,?,?)`);
      for (const r of dump.tables.decisions as any[]) dc.run(r.decision_id, r.result_id, r.action, r.payload, r.created_seq);
      const lk = ins(`INSERT INTO locks (lock_id, region, k_offsets, basis_result_id, status, created_seq) VALUES (?,?,?,?,?,?)`);
      for (const r of dump.tables.locks as any[])
        lk.run(r.lock_id, r.region, r.k_offsets, r.basis_result_id, r.status, r.created_seq);
      const lh = ins(`INSERT INTO lock_history (lock_id, seq, status) VALUES (?,?,?)`);
      for (const r of dump.tables.lock_history as any[]) lh.run(r.lock_id, r.seq, r.status);
    });

    // 导入后引用完整性校验：任何缺失引用都报损坏。
    const results = this.db.prepare(`SELECT result_id, source_refs FROM results`).all() as Array<{
      result_id: string;
      source_refs: string;
    }>;
    for (const r of results) {
      for (const ref of JSON.parse(r.source_refs) as SourceRef[]) {
        if (ref.entityId.startsWith('res-')) {
          const ok = this.db.prepare(`SELECT 1 FROM results WHERE result_id = ?`).get(ref.entityId);
          if (!ok) throw new CorruptionError(`imported ${r.result_id} references missing result ${ref.entityId}`);
        } else {
          this.resolveRef(ref);
        }
      }
    }
    this.seq = (this.db.prepare(`SELECT MAX(seq) AS m FROM events`).get() as { m: number | null }).m ?? 0;
    return {
      imported: Object.fromEntries(
        Object.entries(dump.tables).map(([k, v]) => [k, (v as unknown[]).length]),
      ),
    };
  }
}

interface ResultRow {
  result_id: string;
  kind: string;
  status: string;
  algorithm_version: string;
  param_fingerprint: string;
  source_refs: string;
  region: string | null;
  blob_id: string;
  diagnosis: string | null;
  created_seq: number;
}

export interface ExportDump {
  format: 'interference-book/export';
  formatVersion: number;
  tables: Record<string, Record<string, unknown>[]>;
}

function phaseGridOf(store: Store, candidateResultId: string): { width: number; height: number } {
  const r = store.getResult(candidateResultId);
  const phaseRef = r.sourceRefs[0];
  const v = store.getEntityVersion(phaseRef.entityId, phaseRef.versionNo);
  const g = v.content as { width: number; height: number };
  return { width: g.width, height: g.height };
}
