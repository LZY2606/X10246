/**
 * 机器可读取的事件契约。
 *
 * 每个判定依据都写成事件：接受、否定、参数调整、锁定、冲突、过期、候选生成……
 * 事件只追加（append-only），带 prevHash 形成哈希链；回到任意旧事件时恢复当时的
 * 依赖版本与可见结论，而不是拿最新计算结果覆盖历史。
 */
import type { CounterexampleKind, VerdictStatus } from './model.js';

export type EventType =
  | 'source.imported'
  | 'source.revised'
  | 'wavelength.revised'
  | 'calibration.revised'
  | 'cut.edited'
  | 'analysis.generated'
  | 'candidate.proposed'
  | 'candidate.rejected'
  | 'verdict.accepted'
  | 'verdict.rejected'
  | 'params.adjusted'
  | 'local.locked'
  | 'local.lock-conflict'
  | 'dependency.staled'
  | 'counterexample.evaluated'
  | 'project.opened';

export interface EventRef {
  /** 引用的实体类型与稳定 id */
  kind:
    | 'source'
    | 'wavelength'
    | 'calibration'
    | 'cut-edit'
    | 'analysis'
    | 'tree'
    | 'candidate'
    | 'height-chain'
    | 'lock';
  stableId: string;
  /** 必须显式给出版本号；缺失引用=损坏，不能回退到最新版 */
  version: number;
  /** 内容摘要（contentHash 前缀），用于核对 */
  digest: string;
}

export interface LedgerEvent {
  seq: number;
  eventId: string;
  projectId: string;
  type: EventType;
  atVirtual: number;
  /** 哈希链：前一事件的 hash */
  prevHash: string;
  hash: string;
  operator: string;
  /** 该事件直接依赖的引用（带来源版本与摘要） */
  refs: EventRef[];
  payload: Record<string, unknown>;
  counterexample?: CounterexampleKind;
  verdict?: VerdictStatus;
}

/** 事件流投影出的实体摘要，查询实体时返回其引用版本号与内容摘要 */
export interface EntityResolution {
  kind: EventRef['kind'];
  stableId: string;
  version: number;
  digest: string;
  /** 缺少引用或版本不存在时置损坏 */
  damaged: boolean;
  damageReason?: string;
  summary: string;
}
