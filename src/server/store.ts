import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { contentHash, shortHash } from '../shared/hash';
import { systemClock, type Clock } from '../shared/clock';
import {
  CorruptReferenceError,
  regionContains,
  regionsOverlap,
  type Decision,
  type DecisionAction,
  type DerivedResult,
  type EventRecord,
  type EventSnapshot,
  type EventType,
  type InputKind,
  type InputVersion,
  type Region,
  type SourceRef,
  INPUT_KINDS,
} from '../shared/domain';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS input_versions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  parent_id TEXT,
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,
  affected_region_json TEXT,
  submitted_seq INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL,
  UNIQUE(kind, version_no)
);
CREATE TABLE IF NOT EXISTS derived_results (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  param_fingerprint TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,
  status TEXT NOT NULL,
  pixels_json TEXT,
  created_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  rationale TEXT NOT NULL,
  region_json TEXT,
  param_patch_json TEXT,
  effective INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  type TEXT NOT NULL,
  subjects_json TEXT NOT NULL,
  basis_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export interface EntityView {
  entity: InputVersion | DerivedResult | Decision | EventRecord;
  entityTable: 'input_versions' | 'derived_results' | 'decisions' | 'events';
  references: (SourceRef & { digest: string })[];
}

export class Store {
  private db: DatabaseSync;
  private clock: Clock;
  private seq: number;

  constructor(dbPath: string, clock: Clock = systemClock) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.clock = clock;
    const row = this.db.prepare(`SELECT value FROM meta WHERE key='seq'`).get() as
      | { value: string }
      | undefined;
    this.seq = row ? Number(row.value) : 0;
  }

  close(): void {
    this.db.close();
  }

  private nextSeq(): number {
    this.seq += 1;
    this.db.prepare(`INSERT INTO meta(key,value) VALUES('seq',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(this.seq));
    return this.seq;
  }

  // ---------- 输入层：不可覆盖，修订走新版本 + 父版本 ----------

  submitInput(kind: InputKind, content: unknown, affectedRegion: Region | null = null): InputVersion {
    if (!INPUT_KINDS.includes(kind)) throw new Error(`UNKNOWN_INPUT_KIND:${kind}`);
    const hash = contentHash(content);
    // 内容寻址：相同内容只存一份不可变内容（最小/组合输入共享的原始片段不重复存储）
    const dup = this.db.prepare(`SELECT id FROM input_versions WHERE kind=? AND content_hash=?`).get(kind, hash) as { id: string } | undefined;
    if (dup) return this.getInputVersion(dup.id)!;
    const latest = this.latestInput(kind);
    const versionNo = latest ? latest.versionNo + 1 : 1;
    const id = `inp_${kind}_v${versionNo}_${shortHash(content)}`;
    const existing = this.db.prepare(`SELECT id FROM input_versions WHERE id=?`).get(id);
    if (existing) return this.getInputVersion(id)!;
    const version: InputVersion = {
      id,
      kind,
      versionNo,
      parentId: latest?.id ?? null,
      contentHash: hash,
      content,
      affectedRegion,
      submittedSeq: this.nextSeq(),
      submittedAt: this.clock(),
    };
    this.db.prepare(
      `INSERT INTO input_versions(id,kind,version_no,parent_id,content_hash,content_json,affected_region_json,submitted_seq,submitted_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(
      version.id, version.kind, version.versionNo, version.parentId, version.contentHash,
      JSON.stringify(version.content),
      version.affectedRegion ? JSON.stringify(version.affectedRegion) : null,
      version.submittedSeq, version.submittedAt,
    );
    // 局部输入变化只使依赖它的派生结果过期
    this.markStaleDependents(kind, version, affectedRegion);
    if (kind === 'wavelength' && latest) {
      this.recordEvent('WAVELENGTH_VERSION_CHANGE', [latest.id, version.id], {
        rule: 'wavelength-versioned-height-chain-recomputed',
        from: { id: latest.id, versionNo: latest.versionNo, contentHash: latest.contentHash },
        to: { id: version.id, versionNo: version.versionNo, contentHash: version.contentHash },
      });
    }
    return version;
  }

  private markStaleDependents(kind: InputKind, version: InputVersion, region: Region | null): void {
    const rows = this.db.prepare(
      `SELECT id, sources_json, pixels_json FROM derived_results WHERE status='current'`,
    ).all() as { id: string; sources_json: string; pixels_json: string | null }[];
    for (const row of rows) {
      const sources = JSON.parse(row.sources_json) as SourceRef[];
      const depends = sources.some((s) => s.kind === kind && s.id !== version.id);
      if (!depends) continue;
      let stale = true;
      if (region) {
        const pixels = row.pixels_json ? (JSON.parse(row.pixels_json) as number[]) : null;
        if (pixels) {
          const width = this.gridWidthOf(kind);
          stale = pixels.some((p) => regionContains(region, p, width));
        }
      }
      if (stale) {
        this.db.prepare(`UPDATE derived_results SET status='stale' WHERE id=?`).run(row.id);
      }
    }
  }

  private gridWidthOf(_kind: InputKind): number {
    const wp = this.latestInput('wrapped_phase');
    if (wp) {
      const c = wp.content as { width?: number };
      if (typeof c.width === 'number') return c.width;
    }
    return 1;
  }

  getInputVersion(id: string): InputVersion | null {
    const r = this.db.prepare(`SELECT * FROM input_versions WHERE id=?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this.rowToInput(r) : null;
  }

  latestInput(kind: InputKind): InputVersion | null {
    const r = this.db.prepare(
      `SELECT * FROM input_versions WHERE kind=? ORDER BY version_no DESC LIMIT 1`,
    ).get(kind) as Record<string, unknown> | undefined;
    return r ? this.rowToInput(r) : null;
  }

  inputHistory(kind: InputKind): InputVersion[] {
    const rows = this.db.prepare(
      `SELECT * FROM input_versions WHERE kind=? ORDER BY version_no ASC`,
    ).all(kind) as Record<string, unknown>[];
    return rows.map((r) => this.rowToInput(r));
  }

  private rowToInput(r: Record<string, unknown>): InputVersion {
    return {
      id: r.id as string,
      kind: r.kind as InputKind,
      versionNo: r.version_no as number,
      parentId: (r.parent_id as string) ?? null,
      contentHash: r.content_hash as string,
      content: JSON.parse(r.content_json as string),
      affectedRegion: r.affected_region_json ? JSON.parse(r.affected_region_json as string) : null,
      submittedSeq: r.submitted_seq as number,
      submittedAt: r.submitted_at as number,
    };
  }

  // ---------- 派生层：算法版本 + 参数指纹 + 直接来源 ----------

  saveDerived(
    kind: DerivedResult['kind'],
    algorithmVersion: string,
    fingerprint: string,
    sources: SourceRef[],
    content: unknown,
    pixels: number[] | null,
  ): DerivedResult {
    const hash = contentHash(content);
    const id = `der_${kind}_${shortHash({ kind, algorithmVersion, fingerprint, sources, hash })}`;
    const existing = this.getDerived(id);
    if (existing) return existing;
    const result: DerivedResult = {
      id,
      kind,
      algorithmVersion,
      paramFingerprint: fingerprint,
      sources,
      contentHash: hash,
      content,
      status: 'current',
      pixels,
      createdSeq: this.nextSeq(),
      createdAt: this.clock(),
    };
    this.db.prepare(
      `INSERT INTO derived_results(id,kind,algorithm_version,param_fingerprint,sources_json,content_hash,content_json,status,pixels_json,created_seq,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      result.id, result.kind, result.algorithmVersion, result.paramFingerprint,
      JSON.stringify(sources), result.contentHash, JSON.stringify(content),
      result.status, pixels ? JSON.stringify(pixels) : null,
      result.createdSeq, result.createdAt,
    );
    return result;
  }

  getDerived(id: string): DerivedResult | null {
    const r = this.db.prepare(`SELECT * FROM derived_results WHERE id=?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this.rowToDerived(r) : null;
  }

  derivedByKind(kind: DerivedResult['kind']): DerivedResult[] {
    const rows = this.db.prepare(
      `SELECT * FROM derived_results WHERE kind=? ORDER BY created_seq ASC`,
    ).all(kind) as Record<string, unknown>[];
    return rows.map((r) => this.rowToDerived(r));
  }

  allDerived(): DerivedResult[] {
    const rows = this.db.prepare(`SELECT * FROM derived_results ORDER BY created_seq ASC`).all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToDerived(r));
  }

  private rowToDerived(r: Record<string, unknown>): DerivedResult {
    return {
      id: r.id as string,
      kind: r.kind as DerivedResult['kind'],
      algorithmVersion: r.algorithm_version as string,
      paramFingerprint: r.param_fingerprint as string,
      sources: JSON.parse(r.sources_json as string),
      contentHash: r.content_hash as string,
      content: JSON.parse(r.content_json as string),
      status: r.status as DerivedResult['status'],
      pixels: r.pixels_json ? JSON.parse(r.pixels_json as string) : null,
      createdSeq: r.created_seq as number,
      createdAt: r.created_at as number,
    };
  }

  // ---------- 决定层：接受/否定/锁定/撤销全部写入历史 ----------

  recordDecision(
    action: DecisionAction,
    targetId: string,
    rationale: string,
    region: Region | null = null,
    paramPatch: Record<string, unknown> | null = null,
  ): Decision {
    const seq = this.nextSeq();
    const decision: Decision = {
      id: `dec_${seq}_${shortHash({ action, targetId, rationale, seq }, 8)}`,
      seq,
      action,
      targetId,
      rationale,
      region,
      paramPatch,
      effective: true,
      createdAt: this.clock(),
    };
    this.db.prepare(
      `INSERT INTO decisions(id,seq,action,target_id,rationale,region_json,param_patch_json,effective,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(
      decision.id, decision.seq, decision.action, decision.targetId, decision.rationale,
      region ? JSON.stringify(region) : null,
      paramPatch ? JSON.stringify(paramPatch) : null,
      1, decision.createdAt,
    );
    if (action === 'undo') {
      this.db.prepare(`UPDATE decisions SET effective=0 WHERE id=?`).run(targetId);
    }
    if (action === 'lock_local' && region) {
      const conflicts = this.effectiveLocks().filter(
        (l) => l.candidateId !== targetId && regionsOverlap(l.region, region),
      );
      if (conflicts.length) {
        this.recordEvent('LOCAL_LOCK_CONFLICT', [decision.id, ...conflicts.map((c) => c.lockDecisionId)], {
          rule: 'overlapping-local-locks-must-conflict-explicitly',
          newLock: { decisionId: decision.id, candidateId: targetId, region },
          conflicts,
        });
      }
    }
    this.recordEvent(action === 'undo' ? 'DECISION_UNDONE' : 'DECISION_RECORDED', [decision.id, targetId], {
      action,
      targetId,
      rationale,
      region,
    });
    return decision;
  }

  decisions(): Decision[] {
    const rows = this.db.prepare(`SELECT * FROM decisions ORDER BY seq ASC`).all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToDecision(r));
  }

  private rowToDecision(r: Record<string, unknown>): Decision {
    return {
      id: r.id as string,
      seq: r.seq as number,
      action: r.action as DecisionAction,
      targetId: r.target_id as string,
      rationale: r.rationale as string,
      region: r.region_json ? JSON.parse(r.region_json as string) : null,
      paramPatch: r.param_patch_json ? JSON.parse(r.param_patch_json as string) : null,
      effective: (r.effective as number) === 1,
      createdAt: r.created_at as number,
    };
  }

  effectiveLocks(): { lockDecisionId: string; candidateId: string; region: Region }[] {
    const locks: { lockDecisionId: string; candidateId: string; region: Region }[] = [];
    for (const d of this.decisions()) {
      if (!d.effective) continue;
      if (d.action === 'lock_local' && d.region) {
        locks.push({ lockDecisionId: d.id, candidateId: d.targetId, region: d.region });
      } else if (d.action === 'unlock_local') {
        const idx = locks.findIndex((l) => l.lockDecisionId === d.targetId);
        if (idx >= 0) locks.splice(idx, 1);
      }
    }
    return locks;
  }

  adoptedCandidateId(): string | null {
    let adopted: string | null = null;
    for (const d of this.decisions()) {
      if (d.effective && d.action === 'accept_candidate') adopted = d.targetId;
    }
    return adopted;
  }

  rejectedCandidateIds(): string[] {
    return this.decisions()
      .filter((d) => d.effective && d.action === 'reject_candidate')
      .map((d) => d.targetId);
  }

  // ---------- 事件层：判断依据机器可读；快照可回到任一历史事件 ----------

  recordEvent(type: EventType, subjects: string[], basis: Record<string, unknown>): EventRecord {
    const seq = this.nextSeq();
    const snapshot = this.currentSnapshot(`event:${type}`);
    const event: EventRecord = {
      id: `evt_${seq}_${shortHash({ type, subjects, seq }, 8)}`,
      seq,
      type,
      subjects,
      basis,
      snapshot,
      createdAt: this.clock(),
    };
    this.db.prepare(
      `INSERT INTO events(id,seq,type,subjects_json,basis_json,snapshot_json,created_at)
       VALUES(?,?,?,?,?,?,?)`,
    ).run(
      event.id, event.seq, event.type, JSON.stringify(subjects),
      JSON.stringify(basis), JSON.stringify(snapshot), event.createdAt,
    );
    return event;
  }

  currentSnapshot(notes: string): EventSnapshot {
    const inputVersions: EventSnapshot['inputVersions'] = {};
    for (const kind of INPUT_KINDS) {
      const v = this.latestInput(kind);
      if (v) inputVersions[kind] = v.id;
    }
    const candidates = this.derivedByKind('unwrap_candidate');
    return {
      inputVersions,
      adoptedCandidateId: this.adoptedCandidateId(),
      rejectedCandidateIds: this.rejectedCandidateIds(),
      locks: this.effectiveLocks(),
      currentCandidateIds: candidates.filter((c) => c.status === 'current').map((c) => c.id),
      staleCandidateIds: candidates.filter((c) => c.status === 'stale').map((c) => c.id),
      notes,
    };
  }

  events(): EventRecord[] {
    const rows = this.db.prepare(`SELECT * FROM events ORDER BY seq ASC`).all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToEvent(r));
  }

  getEvent(id: string): EventRecord | null {
    const r = this.db.prepare(`SELECT * FROM events WHERE id=?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this.rowToEvent(r) : null;
  }

  private rowToEvent(r: Record<string, unknown>): EventRecord {
    return {
      id: r.id as string,
      seq: r.seq as number,
      type: r.type as EventType,
      subjects: JSON.parse(r.subjects_json as string),
      basis: JSON.parse(r.basis_json as string),
      snapshot: JSON.parse(r.snapshot_json as string),
      createdAt: r.created_at as number,
    };
  }

  // 回到任一旧事件：恢复当时的依赖版本与可见结论（只读视图，不覆盖历史）
  eventView(eventId: string): { event: EventRecord; resolvedInputs: Record<string, InputVersion | null> } {
    const event = this.getEvent(eventId);
    if (!event) throw new Error(`EVENT_NOT_FOUND:${eventId}`);
    const resolvedInputs: Record<string, InputVersion | null> = {};
    for (const [kind, id] of Object.entries(event.snapshot.inputVersions)) {
      resolvedInputs[kind] = this.getInputVersion(id);
    }
    return { event, resolvedInputs };
  }

  // ---------- 实体查询：返回引用版本号与内容摘要；缺引用即损坏，绝不退回最新版 ----------

  entity(id: string): EntityView {
    const input = this.getInputVersion(id);
    if (input) {
      const references: EntityView['references'] = [];
      if (input.parentId) {
        const parent = this.getInputVersion(input.parentId);
        if (!parent) throw new CorruptReferenceError([{ id: input.parentId, referencedBy: id }]);
        references.push({
          id: parent.id, kind: parent.kind, versionNo: parent.versionNo,
          contentHash: parent.contentHash, digest: parent.contentHash.slice(0, 16),
        });
      }
      return { entity: input, entityTable: 'input_versions', references };
    }
    const derived = this.getDerived(id);
    if (derived) {
      const missing: { id: string; referencedBy: string }[] = [];
      const references: EntityView['references'] = [];
      for (const src of derived.sources) {
        const srcInput = this.getInputVersion(src.id);
        const srcDerived = srcInput ? null : this.getDerived(src.id);
        const found = srcInput ?? srcDerived;
        if (!found) {
          missing.push({ id: src.id, referencedBy: id });
          continue;
        }
        references.push({
          id: found.id,
          kind: found.kind,
          versionNo: 'versionNo' in found ? found.versionNo : found.createdSeq,
          contentHash: found.contentHash,
          digest: found.contentHash.slice(0, 16),
        });
      }
      if (missing.length) throw new CorruptReferenceError(missing);
      return { entity: derived, entityTable: 'derived_results', references };
    }
    const decision = this.decisions().find((d) => d.id === id);
    if (decision) return { entity: decision, entityTable: 'decisions', references: [] };
    const event = this.getEvent(id);
    if (event) return { entity: event, entityTable: 'events', references: [] };
    throw new Error(`ENTITY_NOT_FOUND:${id}`);
  }

  // ---------- 导出 / 导入：身份、顺序、来源关系保持 ----------

  exportAll(): Record<string, unknown> {
    const inputs = this.db.prepare(`SELECT * FROM input_versions ORDER BY submitted_seq ASC`).all();
    const derived = this.db.prepare(`SELECT * FROM derived_results ORDER BY created_seq ASC`).all();
    const decisions = this.db.prepare(`SELECT * FROM decisions ORDER BY seq ASC`).all();
    const events = this.db.prepare(`SELECT * FROM events ORDER BY seq ASC`).all();
    const meta = this.db.prepare(`SELECT * FROM meta`).all();
    return {
      format: 'fringe-book-export@1',
      exportedSeq: this.seq,
      tables: { input_versions: inputs, derived_results: derived, decisions, events, meta },
    };
  }

  importAll(payload: Record<string, unknown>): { imported: Record<string, number> } {
    if (payload.format !== 'fringe-book-export@1') throw new Error('BAD_EXPORT_FORMAT');
    const tables = payload.tables as Record<string, Record<string, unknown>[]>;
    const counts: Record<string, number> = {};
    const insertRows = (table: string, rows: Record<string, unknown>[], cols: string[]) => {
      let n = 0;
      const stmt = this.db.prepare(
        `INSERT OR IGNORE INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`,
      );
      for (const row of rows) {
        stmt.run(...cols.map((c) => (row[c] === undefined ? null : (row[c] as string | number | null))));
        n++;
      }
      counts[table] = n;
    };
    insertRows('input_versions', tables.input_versions ?? [], [
      'id','kind','version_no','parent_id','content_hash','content_json','affected_region_json','submitted_seq','submitted_at',
    ]);
    insertRows('derived_results', tables.derived_results ?? [], [
      'id','kind','algorithm_version','param_fingerprint','sources_json','content_hash','content_json','status','pixels_json','created_seq','created_at',
    ]);
    insertRows('decisions', tables.decisions ?? [], [
      'id','seq','action','target_id','rationale','region_json','param_patch_json','effective','created_at',
    ]);
    insertRows('events', tables.events ?? [], [
      'id','seq','type','subjects_json','basis_json','snapshot_json','created_at',
    ]);
    const maxSeq = Math.max(
      this.seq,
      ...((tables.events ?? []).map((e) => Number(e.seq) || 0)),
      ...((tables.decisions ?? []).map((d) => Number(d.seq) || 0)),
      ...((tables.input_versions ?? []).map((i) => Number(i.submitted_seq) || 0)),
      ...((tables.derived_results ?? []).map((d) => Number(d.created_seq) || 0)),
    );
    this.seq = maxSeq;
    this.db.prepare(`INSERT INTO meta(key,value) VALUES('seq',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(maxSeq));
    return { imported: counts };
  }

  reset(): void {
    this.db.exec(`DELETE FROM input_versions; DELETE FROM derived_results; DELETE FROM decisions; DELETE FROM events; DELETE FROM meta;`);
    this.seq = 0;
  }
}
