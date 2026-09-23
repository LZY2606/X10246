import { rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db';
import { contentHash, shortHash } from '../shared/hash';
import type { Clock } from '../shared/clock';
import type {
  CutEditHistoryData, DecisionType, DerivedKind, DerivedStatus,
  DerivedSourceRef, Diagnostic, GridData, HeightMapPayload,
  InputContent, InputKind, QualityMapPayload, SourceRef, UnwrapCandidatePayload,
  ComponentMapPayload, CutNetworkPayload, LoopResidualsPayload,
  CalibrationPlaneData, IncidenceGeometryData, WavelengthData,
} from '../shared/types';
import {
  ALGORITHM_VERSIONS, computeComponentMap, computeLoopResiduals,
  computeQualityMap, computeUnwrapCandidate, compareCandidates, foldCutNetwork,
  type UnwrapParams,
} from '../domain/unwrap';
import { computeHeightMap } from '../domain/height';

export class CorruptionError extends Error { code = 'CORRUPTION'; }
export class ContractError extends Error { code = 'CONTRACT'; }
export class FormatError extends Error { code = 'FORMAT'; }

type AnySource = SourceRef | DerivedSourceRef;

export interface DerivedRow {
  derivedId: string;
  kind: DerivedKind;
  algorithmVersion: string;
  paramsFingerprint: string;
  sources: AnySource[];
  payloadHash: string;
  digest: string;
  status: DerivedStatus;
  createdSeq: number;
}

export interface InputRow {
  inputId: string;
  kind: InputKind;
  version: number;
  parentVersion: number | null;
  blobHash: string;
  digest: string;
  createdSeq: number;
}

export interface EventRow {
  seq: number;
  eventId: string;
  type: string;
  at: number;
  payload: any;
}

export interface LockRow {
  lockId: string;
  candidateId: string;
  region: number[];
  kValues: number[];
  status: 'active' | 'released';
  createdSeq: number;
}

const GRID_KINDS = new Set<InputKind>(['wrapped_phase', 'snr_score', 'invalid_mask']);

function hydrateDerived(row: any): DerivedRow {
  return {
    derivedId: row.derived_id,
    kind: row.kind,
    algorithmVersion: row.algorithm_version,
    paramsFingerprint: row.params_fingerprint,
    sources: JSON.parse(row.sources),
    payloadHash: row.payload_hash,
    digest: row.digest,
    status: row.status,
    createdSeq: row.created_seq,
  };
}

export class ReviewService {
  private db: DatabaseSync;
  private clock: Clock;
  readonly dbPath: string;

  constructor(dbPath: string, clock: Clock) {
    this.dbPath = dbPath;
    this.db = openDb(dbPath);
    this.clock = clock;
  }

  close(): void { this.db.close(); }

  // ---------------- 内容寻址存储 ----------------
  private putBlob(value: unknown): string {
    const hash = contentHash(value);
    this.db.prepare('INSERT OR IGNORE INTO blobs(hash, content) VALUES(?,?)')
      .run(hash, JSON.stringify(value));
    return hash;
  }

  private getBlob(hash: string): unknown {
    const row = this.db.prepare('SELECT content FROM blobs WHERE hash=?').get(hash) as { content: string } | undefined;
    if (!row) throw new CorruptionError(`内容块缺失：${hash}`);
    return JSON.parse(row.content);
  }

  blobCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM blobs').get() as { c: number }).c;
  }

  /** 存不可变内容；Grid 的 values 作为共享片段单独去重，只存一份。 */
  private storeContent(kind: InputKind, content: InputContent): { blobHash: string; digest: string } {
    let stored: unknown = content;
    if (GRID_KINDS.has(kind)) {
      const grid = content as GridData;
      const valuesRef = this.putBlob(grid.values);
      stored = {
        width: grid.width, height: grid.height, unit: grid.unit,
        coordBasis: grid.coordBasis, raw: grid.raw ?? null, valuesRef,
      };
    }
    const blobHash = this.putBlob(stored);
    return { blobHash, digest: contentHash(stored) };
  }

  // ---------------- 查询：缺引用必报损坏，禁止退回最新版 ----------------
  private inputRow(inputId: string, version?: number): InputRow {
    const row = version === undefined
      ? this.db.prepare('SELECT * FROM inputs WHERE input_id=? ORDER BY version DESC LIMIT 1').get(inputId) as InputRow | undefined
      : this.db.prepare('SELECT * FROM inputs WHERE input_id=? AND version=?').get(inputId, version) as InputRow | undefined;
    if (!row) throw new CorruptionError(`缺少引用：${inputId}${version === undefined ? '' : `@v${version}`}`);
    return row;
  }

  getInput(inputId: string, version?: number): { row: InputRow; content: InputContent } {
    const row = this.inputRow(inputId, version);
    const stored = this.getBlob(row.blobHash) as any;
    let content = stored as InputContent;
    if (GRID_KINDS.has(row.kind)) {
      content = { ...stored, values: this.getBlob(stored.valuesRef) } as GridData;
    }
    return { row, content };
  }

  private derivedRow(derivedId: string): DerivedRow {
    const row = this.db.prepare('SELECT * FROM derived WHERE derived_id=?').get(derivedId) as any;
    if (!row) throw new CorruptionError(`缺少引用：${derivedId}`);
    return hydrateDerived(row);
  }

  getDerived(derivedId: string): { row: DerivedRow; payload: unknown } {
    const row = this.derivedRow(derivedId);
    return { row, payload: this.getBlob(row.payloadHash) };
  }

  private sourceRef(inputId: string): SourceRef {
    const { row } = this.getInput(inputId);
    return { inputId, version: row.version, digest: row.digest };
  }

  private derivedSourceRef(derivedId: string): DerivedSourceRef {
    const row = this.derivedRow(derivedId);
    return { derivedId, digest: row.digest };
  }

  // ---------------- 事件溯源 ----------------
  private appendEvent(type: string, payload: unknown): EventRow {
    const seq = ((this.db.prepare('SELECT MAX(seq) AS s FROM events').get() as { s: number | null }).s ?? 0) + 1;
    const event: EventRow = { seq, eventId: `evt_${seq}`, type, at: this.clock(), payload };
    this.db.prepare('INSERT INTO events(seq,event_id,type,at,payload) VALUES(?,?,?,?,?)')
      .run(event.seq, event.eventId, event.type, event.at, JSON.stringify(payload));
    this.fold(event);
    return event;
  }

  /** 投影折叠：在线写入、导入与历史重放共用同一路径。 */
  private fold(event: EventRow): void {
    const p = event.payload as any;
    switch (event.type) {
      case 'input_committed':
      case 'input_revised':
        this.db.prepare(
          'INSERT INTO inputs(input_id,kind,version,parent_version,blob_hash,digest,created_seq) VALUES(?,?,?,?,?,?,?)',
        ).run(p.inputId, p.kind, p.version, p.parentVersion ?? null, p.blobHash, p.digest, event.seq);
        break;
      case 'derived_computed':
        this.db.prepare(
          `INSERT INTO derived(derived_id,kind,algorithm_version,params_fingerprint,sources,payload_hash,digest,status,created_seq)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        ).run(p.derivedId, p.kind, p.algorithmVersion, p.paramsFingerprint,
          JSON.stringify(p.sources), p.payloadHash, p.digest, 'proposed', event.seq);
        break;
      case 'derived_staled':
        this.db.prepare("UPDATE derived SET status='stale' WHERE derived_id=?").run(p.derivedId);
        break;
      case 'decision_accepted':
        this.db.prepare("UPDATE derived SET status='proposed' WHERE status='accepted'").run();
        this.db.prepare("UPDATE derived SET status='accepted' WHERE derived_id=?").run(p.derivedId);
        break;
      case 'decision_rejected':
        this.db.prepare("UPDATE derived SET status='rejected' WHERE derived_id=?").run(p.derivedId);
        break;
      case 'lock_conflict':
        this.db.prepare("UPDATE derived SET status='conflicted' WHERE derived_id=?").run(p.derivedId);
        break;
      case 'region_locked':
        this.db.prepare(
          'INSERT INTO locks(lock_id,candidate_id,region,k_values,status,created_seq) VALUES(?,?,?,?,?,?)',
        ).run(p.lockId, p.candidateId, JSON.stringify(p.region), JSON.stringify(p.kValues), 'active', event.seq);
        break;
      case 'region_unlocked':
        this.db.prepare("UPDATE locks SET status='released' WHERE lock_id=?").run(p.lockId);
        break;
      case 'decision_reverted': {
        const target = this.db.prepare('SELECT * FROM events WHERE seq=?').get(p.targetSeq) as any;
        if (!target) throw new CorruptionError(`撤销目标事件缺失：seq=${p.targetSeq}`);
        const tp = JSON.parse(target.payload);
        if (target.type === 'decision_accepted' || target.type === 'decision_rejected') {
          this.db.prepare("UPDATE derived SET status='proposed' WHERE derived_id=?").run(tp.derivedId);
        } else if (target.type === 'region_locked') {
          this.db.prepare("UPDATE locks SET status='released' WHERE lock_id=?").run(tp.lockId);
        } else if (target.type === 'region_unlocked') {
          this.db.prepare("UPDATE locks SET status='active' WHERE lock_id=?").run(tp.lockId);
        }
        break;
      }
      default:
        break; // 诊断/判断记录只进日志，不改投影
    }
  }
