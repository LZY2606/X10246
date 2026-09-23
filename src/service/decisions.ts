/**
 * 人工裁定：候选 accept/reject/adjust、局部锁定（含冲突）、撤销/回滚。
 * 所有决定都生成新事件；冲突解决与撤销也写入历史。
 * 锁定把当时依赖版本绑死；回到旧事件恢复当时版本，不用最新覆盖。
 */
import type { Ledger } from '../db/ledger.ts';
import { VirtualClock } from '../domain/rng.ts';
import { projectState } from '../db/projection.ts';
import type {
  CandidateDecisionContent,
  RegionLockContent,
  ReversalContent,
  IntegerCandidatesContent,
  CutEdit,
} from '../domain/types.ts';

export class DecisionError extends Error {}

export function decideCandidate(opts: {
  ledger: Ledger;
  projectId: string;
  clock: VirtualClock;
  integerCandidatesEventId: string;
  ambiguityId: string;
  decision: 'accept' | 'reject' | 'adjust';
  chosenK: number | null;
  rejectedK?: number[];
  rationale: string;
  parameterAdjustment?: Record<string, number | string>;
}) {
  const ev = opts.ledger.getEvent(opts.integerCandidatesEventId);
  if (!ev) throw new DecisionError('MISSING_INTEGER_EVENT');
  const payload = ev.payload as IntegerCandidatesContent;
  const amb = payload.ambiguities.find((a) => a.ambiguityId === opts.ambiguityId);
  if (!amb) throw new DecisionError('MISSING_AMBIGUITY:' + opts.ambiguityId);

  if (opts.decision === 'accept' && opts.chosenK !== null) {
    const opt = amb.options.find((o) => o.k === opts.chosenK);
    if (!opt || !opt.legal) {
      throw new DecisionError('CANNOT_ADOPT_ILLEGAL_K:' + opts.chosenK);
    }
  }

  const content: CandidateDecisionContent = {
    decision: opts.decision,
    ambiguityId: opts.ambiguityId,
    chosenK: opts.decision === 'accept' ? opts.chosenK : null,
    rejectedK: opts.rejectedK ?? (opts.decision === 'reject' && opts.chosenK !== null ? [opts.chosenK] : []),
    rationale: opts.rationale,
    at: opts.clock.peek(),
    integerCandidatesEventId: opts.integerCandidatesEventId,
    parameterAdjustment: opts.parameterAdjustment,
  };
  return opts.ledger.append(
    opts.projectId,
    {
      type: 'candidate.decided',
      entity: {
        type: 'candidateDecision',
        key: amb.ambiguityId,
      },
      payload: content,
      refs: [opts.integerCandidatesEventId],
      actor: 'human',
    },
    () => opts.clock.now(),
  );
}

/**
 * 锁定局部解读。若同一 regionId 已存在 active 锁但解读/绑定版本不同，
 * 记录 lock-conflict（不静默覆盖）；冲突解决（解决后再次锁定）也追加事件。
 */
export function lockRegion(opts: {
  ledger: Ledger;
  projectId: string;
  clock: VirtualClock;
  regionId: string;
  interpretation: string;
  bound: RegionLockContent['bound'];
  forceResolve?: boolean;
}) {
  const state = projectState(opts.ledger, opts.projectId);
  const conflicts: string[] = [];
  for (const view of state.entities.values()) {
    if (view.type !== 'regionLock') continue;
    const latest = view.versions[view.versions.length - 1].event
      .payload as RegionLockContent;
    if (
      latest.regionId === opts.regionId &&
      latest.lock === 'locked' &&
      latest.status === 'active'
    ) {
      if (
        latest.interpretation !== opts.interpretation ||
        latest.bound.heightChainEventId !== opts.bound.heightChainEventId
      ) {
        conflicts.push(view.key);
      }
    }
  }

  let status: RegionLockContent['status'] = 'active';
  if (conflicts.length && !opts.forceResolve) status = 'conflict';

  const content: RegionLockContent = {
    regionId: opts.regionId,
    lock: 'locked',
    interpretation: opts.interpretation,
    at: opts.clock.peek(),
    bound: opts.bound,
    conflictsWith: conflicts,
    status,
  };
  return opts.ledger.append(
    opts.projectId,
    {
      type: 'region.locked',
      entity: { type: 'regionLock', key: 'lock:' + opts.regionId },
      payload: content,
      refs: [opts.bound.heightChainEventId, opts.bound.unwrapTreeEventId].filter(Boolean) as string[],
      actor: 'human',
    },
    () => opts.clock.now(),
  );
}

export function unlockRegion(opts: {
  ledger: Ledger;
  projectId: string;
  clock: VirtualClock;
  regionId: string;
  reason: string;
}) {
  const content: RegionLockContent = {
    regionId: opts.regionId,
    lock: 'unlocked',
    interpretation: '',
    at: opts.clock.peek(),
    bound: { heightChainEventId: '', unwrapTreeEventId: '', integerCandidatesEventId: null },
    conflictsWith: [],
    status: 'superseded',
  };
  return opts.ledger.append(
    opts.projectId,
    {
      type: 'region.locked',
      entity: { type: 'regionLock', key: 'lock:' + opts.regionId },
      payload: content,
      refs: [],
      actor: 'human',
    },
    () => opts.clock.now(),
  );
}

/** 撤销/回滚：记录目标事件，并保存恢复的依赖版本快照（不删除历史）。 */
export function reverseHistory(opts: {
  ledger: Ledger;
  projectId: string;
  clock: VirtualClock;
  kind: 'undo' | 'rollback';
  targetEventId: string;
  reason: string;
}) {
  const target = opts.ledger.getEvent(opts.targetEventId);
  if (!target) throw new DecisionError('MISSING_TARGET_EVENT');
  const restoredRefs: Record<string, string> = {};
  target.refs.forEach((r, i) => (restoredRefs['ref' + i] = r));
  const content: ReversalContent = {
    kind: opts.kind,
    targetEventId: opts.targetEventId,
    at: opts.clock.peek(),
    reason: opts.reason,
    restoredRefs,
  };
  return opts.ledger.append(
    opts.projectId,
    {
      type: 'history.reversed',
      entity: { type: 'reversal', key: 'rev:' + target.seq },
      payload: content,
      refs: [opts.targetEventId],
      actor: 'human',
    },
    () => opts.clock.now(),
  );
}

/** 追加一条支路切口编辑（只追加到 cutEditHistory 新版本）。 */
export function appendCutEdit(opts: {
  ledger: Ledger;
  projectId: string;
  clock: VirtualClock;
  edit: Omit<CutEdit, 'editId' | 'at'>;
}) {
  const prev = opts.ledger.latestEntityEventId(opts.projectId, 'cutEditHistory', 'main');
  const prevPayload = prev
    ? (opts.ledger.getEvent(prev)!.payload as { edits: CutEdit[] })
    : { edits: [] };
  const edit: CutEdit = {
    ...opts.edit,
    editId: 'edit:' + (prevPayload.edits.length + 1),
    at: opts.clock.peek(),
  };
  return opts.ledger.append(
    opts.projectId,
    {
      type: 'cut.edited',
      entity: { type: 'cutEditHistory', key: 'main' },
      payload: { edits: [...prevPayload.edits, edit], rawRepresentation: {} },
      refs: prev ? [prev] : [],
      actor: edit.actor,
      parentVersionEventId: prev,
    },
    () => opts.clock.now(),
  );
}
