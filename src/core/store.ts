import type {
  Bundle,
  CounterExampleArchive,
  CounterScenario,
  Entity,
  EventBase,
  EventType,
  InvariantJudgement,
  Project,
  ProvenanceRef,
  ReviewDecision,
  InterpretationLock,
  SourceContent,
  SourceKind,
  ContentKind,
  ScenarioRecord,
} from "../shared/domain.ts";
import type { UnwrapParams } from "./algorithm.ts";
import {
  ALGORITHM_VERSION,
  CorruptionError,
  HEIGHT_CHAIN_VERSION,
  SCHEMA_VERSION
} from "../shared/domain.ts";
import { digestOf, shortHash } from "../shared/hash.ts";
import {
  computeQuality,
  convertHeight,
  DEFAULT_PARAMS,
  detectResidues,
  evaluateCycles,
  placeCuts,
  unwrap
} from "./algorithm.ts";
import { parameterFingerprint } from "./rng.ts";
import { buildEntity, lineageIdFor, refOf } from "./ids.ts";

export interface ClockLike {
  now(): string;
  tick?(ms: number): void;
}

export interface StoreEnv {
  clock: ClockLike;
  seed: string;
}

export interface State {
  project: Project | null;
  events: EventBase[];
  entities: Record<string, Entity>; // entityId -> entity（所有版本保留）
  lineageHeads: Record<string, string>; // lineageId -> entityId
  blobs: Record<string, unknown>;
  archive: CounterExampleArchive;
  /** 派生新鲜度索引：直接来源 digest -> 依赖它的 entityId 集合 */
  dependencyIndex: Record<string, Set<string>>;
  params: UnwrapParams;
  paramsHistory: { params: UnwrapParams; at: string; reason: string }[];
}

export function emptyArchive(): CounterExampleArchive {
  return { version: "archive@1", baseline: null, records: {} };
}

export function createState(): State {
  return {
    project: null,
    events: [],
    entities: {},
    lineageHeads: {},
    blobs: {},
    archive: emptyArchive(),
    dependencyIndex: {},
    params: { ...DEFAULT_PARAMS },
    paramsHistory: []
  };
}

function nextSeq(state: State): number {
  return state.events.length + 1;
}

function emit(
  state: State,
  env: StoreEnv,
  type: EventType,
  machine: Record<string, unknown>,
  refs: ProvenanceRef[],
  affected: string[],
  note?: string
): EventBase {
  const seq = nextSeq(state);
  const event: EventBase = {
    seq,
    eventId: `evt-${String(seq).padStart(4, "0")}-${shortHash({ type, seq, at: env.clock.now(), machine })}`,
    type,
    at: env.clock.now(),
    seed: env.seed,
    refs,
    affected,
    machine,
    note
  };
  state.events.push(event);
  if (state.project) state.project.headSeq = seq;
  return event;
}

/** 保存一个实体：同 lineage 推进版本，登记直接来源依赖。 */
function saveEntity(
  state: State,
  env: StoreEnv,
  kind: ContentKind,
  content: Entity["content"],
  directSources: ProvenanceRef[],
  opts: { algorithmVersion?: string; parameterFingerprint?: string; lineageSalt?: string } = {}
): Entity {
  const lid = lineageIdFor(kind, content, opts.lineageSalt);
  const parentEntity = state.lineageHeads[lid] ? state.entities[state.lineageHeads[lid]] : null;
  const version = parentEntity ? parentEntity.version + 1 : 1;
  const entity = buildEntity(
    {
      kind,
      content,
      version,
      parent: parentEntity,
      lineageSalt: opts.lineageSalt,
      algorithmVersion: opts.algorithmVersion,
      parameterFingerprint: opts.parameterFingerprint,
      directSources,
      createdAt: env.clock.now()
    },
    parentEntity ?? undefined
  );
  state.entities[entity.entityId] = entity;
  state.lineageHeads[entity.lineageId] = entity.entityId;
  for (const ref of directSources) {
    (state.dependencyIndex[ref.digest] ??= new Set()).add(entity.entityId);
  }
  return entity;
}

// ---------- 查询 ----------

export class MissingReferenceError extends CorruptionError {}

/** 查询实体：返回它引用的确切版本号与内容摘要；缺少引用 => 损坏，绝不退回最新版。 */
export function getEntity(state: State, entityId: string): Entity {
  const e = state.entities[entityId];
  if (!e) throw new CorruptionError("missing-reference", `实体 ${entityId} 不存在，且不允许回退到最新版`);
  return e;
}

export function resolveRef(state: State, ref: ProvenanceRef): Entity {
  const e = state.entities[ref.entityId];
  if (!e) throw new CorruptionError("missing-reference", `引用 ${ref.entityId} 缺失（损坏）`);
  if (e.version !== ref.version)
    throw new CorruptionError("missing-reference", `引用 ${ref.entityId} 要求 v${ref.version}，现有 v${e.version}`);
  if (e.digest !== ref.digest)
    throw new CorruptionError("digest-mismatch", `引用 ${ref.entityId} 摘要不一致：期望 ${ref.digest.slice(0, 10)} 实际 ${e.digest.slice(0, 10)}`);
  return e;
}

export function headOfKind(state: State, kind: SourceKind): Entity | null {
  const found = Object.values(state.lineageHeads)
    .map((id) => state.entities[id])
    .filter((e) => e.kind === kind);
  return found[found.length - 1] ?? null;
}

export function allVersions(state: State, lineageId: string): Entity[] {
  return Object.values(state.entities)
    .filter((e) => e.lineageId === lineageId)
    .sort((a, b) => a.version - b.version);
}

/** 派生结果新鲜度：任一传递来源 digest 与当前族头不一致 => 过期（仍可查看）。 */
export function computeFreshness(state: State): void {
  for (const entity of Object.values(state.entities)) {
    if (entity.directSources.length === 0) {
      entity.freshness = "current";
      continue;
    }
    let stale = false;
    const reasons: string[] = [];
    for (const ref of entity.directSources) {
      const src = state.entities[ref.entityId];
      if (!src) {
        stale = true;
        reasons.push(`来源缺失 ${ref.entityId}`);
        continue;
      }
      const headId = state.lineageHeads[src.lineageId];
      if (headId !== src.entityId) {
        stale = true;
        reasons.push(`${src.kind} 已更新到 v${state.entities[headId].version}（本结果基于 v${src.version}）`);
      }
    }
    entity.freshness = stale ? "stale" : "current";
    entity.staleReason = stale ? reasons.join("；") : undefined;
  }
}

export function dependencyChain(state: State, entityId: string): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    const e = state.entities[id];
    if (!e) return;
    for (const ref of e.directSources) {
      out.push(ref.entityId);
      walk(ref.entityId);
    }
  };
  walk(entityId);
  return [...new Set(out)];
}

// ---------- 命令（状态机迁移） ----------

export class ActionError extends Error {
  constructor(public code: string, detail: string) {
    super(`[action:${code}] ${detail}`);
    this.name = "ActionError";
  }
}

type SourceEntityKinds = Extract<Entity["content"], SourceContent>["kind"];

export function createProject(state: State, env: StoreEnv, title: string): Project {
  if (state.project) throw new ActionError("exists", "项目已存在");
  const project: Project = {
    projectId: `proj-${shortHash({ title, seed: env.seed }, 10)}`,
    title,
    createdAt: env.clock.now(),
    headSeq: 0,
    schemaVersion: SCHEMA_VERSION
  };
  state.project = project;
  emit(state, env, "ProjectCreated", { title, projectId: project.projectId }, [], [], "创建光学复核项目");
  return project;
}

/** 提交不可覆盖原始输入；修订走 commitSourceRevision（新版本+父版本）。 */
export function commitSource(state: State, env: StoreEnv, content: SourceContent, fragments?: unknown[]): Entity {
  assertProject(state);
  const existing = headOfKind(state, content.kind as SourceKind);
  if (existing) throw new ActionError("immutable", `${content.kind} 已存在，原始输入不可覆盖；请使用修订接口创建新版本`);
  const fragmentHashes = registerFragments(state, fragments ?? [content]);
  const entity = saveSourceEntity(state, env, content);
  emit(
    state,
    env,
    "SourceCommitted",
    { kind: content.kind, immutable: true, fragmentHashes },
    [],
    [entity.entityId],
    `${entity.summary}（提交后不可覆盖）`
  );
  return entity;
}

/** 源数据修订：新版本 + 父版本关系；局部输入变化只使依赖它的派生过期。 */
export function commitSourceRevision(
  state: State,
  env: StoreEnv,
  content: SourceContent,
  reason: string,
  localOnly: boolean,
  fragments?: unknown[]
): Entity {
  assertProject(state);
  const fragmentHashes = registerFragments(state, fragments ?? [content]);
  const entity = saveSourceEntity(state, env, content);
  emit(
    state,
    env,
    localOnly ? "SourceLocallyChanged" : "ParameterRevised",
    {
      kind: content.kind,
      version: entity.version,
      parentVersionId: entity.parentVersionId,
      localOnly,
      reason,
      fragmentHashes
    },
    entity.parentVersionId ? [refOf(state.entities[entity.parentVersionId])] : [],
    [entity.entityId],
    reason
  );
  recomputeStalenessAfterChange(state, env, entity);
  return entity;
}

export function reviseParameters(state: State, env: StoreEnv, next: Partial<UnwrapParams>, reason: string): void {
  assertProject(state);
  const merged = { ...state.params, ...next };
  state.params = merged;
  state.paramsHistory.push({ params: merged, at: env.clock.now(), reason });
  emit(
    state,
    env,
    "ParameterRevised",
    { previousFingerprint: parameterFingerprint((state.paramsHistory.at(-2)?.params ?? DEFAULT_PARAMS) as unknown as Record<string, unknown>), nextFingerprint: parameterFingerprint(merged as unknown as Record<string, unknown>), changes: next },
    [],
    collectDerivedAffected(state),
    `参数修订：${reason}`
  );
  // 参数变更使全部派生过期（标记，不删除）
  markDerivedStale(state, "算法参数修订，旧派生结果保持可查看但非当前");
}

function saveSourceEntity(state: State, env: StoreEnv, content: SourceContent): Entity {
  return saveEntity(state, env, content.kind, content, []);
}

function registerFragments(state: State, fragments: unknown[]): string[] {
  const hashes: string[] = [];
  for (const f of fragments) {
    const h = digestOf(f);
    if (!(h in state.blobs)) state.blobs[h] = f; // 共享原始片段只存一份
    hashes.push(h);
  }
  return hashes;
}

function recomputeStalenessAfterChange(state: State, env: StoreEnv, changed: Entity): void {
  void env;
  computeFreshness(state);
  const dependent = collectDependents(state, changed.digest);
  for (const id of dependent) {
    const e = state.entities[id];
    if (e.freshness === "stale") e.staleReason = `直接/间接来源 ${changed.kind} 变更（局部）`;
  }
}

function collectDependents(state: State, digest: string): string[] {
  const out = new Set<string>();
  const walk = (d: string) => {
    for (const id of state.dependencyIndex[d] ?? []) {
      if (!out.has(id)) {
        out.add(id);
        walk(state.entities[id].digest);
      }
    }
  };
  walk(digest);
  return [...out];
}

function collectDerivedAffected(state: State): string[] {
  return Object.values(state.entities)
    .filter((e) => e.directSources.length > 0)
    .map((e) => e.entityId);
}

function markDerivedStale(state: State, reason: string): void {
  for (const e of Object.values(state.entities)) {
    if (e.directSources.length > 0) {
      e.freshness = "stale";
      e.staleReason = reason;
    }
  }
}

function assertProject(state: State): asserts state is State & { project: Project } {
  if (!state.project) throw new ActionError("no-project", "尚未创建项目");
}

// ---------- 派生流水线 ----------

function requireHeads(state: State) {
  const phase = headOfKind(state, "WrappedPhaseFrame");
  const amp = headOfKind(state, "AmplitudeFrame");
  const snr = headOfKind(state, "SnrScoreFrame");
  const mask = headOfKind(state, "InvalidMask");
  const wavelength = headOfKind(state, "Wavelength");
  const geometry = headOfKind(state, "IncidenceGeometry");
  const calibration = headOfKind(state, "CalibrationSurface");
  const cuts = headOfKind(state, "CutEditHistory");
  const missing = [
    ["WrappedPhaseFrame", phase],
    ["AmplitudeFrame", amp],
    ["SnrScoreFrame", snr],
    ["InvalidMask", mask],
    ["Wavelength", wavelength],
    ["IncidenceGeometry", geometry]
  ].filter(([, e]) => !e) as [string, Entity | null][];
  if (missing.length) throw new ActionError("missing-source", `缺少输入：${missing.map((m) => m[0]).join("、")}`);
  return {
    phase: phase!,
    amp: amp!,
    snr: snr!,
    mask: mask!,
    wavelength: wavelength!,
    geometry: geometry!,
    calibration,
    cuts
  };
}

function asContent<E extends Entity>(e: Entity): E["content"] {
  return e.content as E["content"];
}

export interface PipelineResult {
  quality: Entity;
  residues: Entity;
  cutNetwork: Entity;
  unwrap: Entity;
  cycles: Entity;
  heights: Record<string, Entity>; // treeId -> height entity
}

/** 从当前族头完整计算，每个派生值带算法版本、参数指纹、直接来源。 */
export interface PipelineOptions {
  note?: string;
  salt?: string;
  parameterFingerprintOverride?: string;
}

export function runPipeline(state: State, env: StoreEnv, noteOrOptions?: string | PipelineOptions): PipelineResult {
  assertProject(state);
  const options: PipelineOptions =
    typeof noteOrOptions === "string" ? { note: noteOrOptions } : noteOrOptions ?? {};
  const note = options.note;
  const salt = options.salt;
  const heads = requireHeads(state);
  const phaseC = asContent<Entity & { content: import("../shared/domain").WrappedPhaseFrame }>(heads.phase) as import("../shared/domain").WrappedPhaseFrame;
  const ampC = heads.amp.content as import("../shared/domain").AmplitudeFrame;
  const snrC = heads.snr.content as import("../shared/domain").SnrScoreFrame;
  const maskC = heads.mask.content as import("../shared/domain").InvalidMask;
  const wavelengthC = heads.wavelength.content as import("../shared/domain").Wavelength;
  const geometryC = heads.geometry.content as import("../shared/domain").IncidenceGeometry;
  const calibrationC = heads.calibration?.content as import("../shared/domain").CalibrationSurface | undefined;
  const cutsHistoryC = heads.cuts?.content as import("../shared/domain").CutEditHistory | undefined;

  const pf = options.parameterFingerprintOverride ?? parameterFingerprint(state.params as unknown as Record<string, unknown>);
  const baseRefs = [heads.phase, heads.amp, heads.snr, heads.mask].map(refOf);

  const quality = saveEntity(state, env, "QualityMap", computeQuality(phaseC, ampC, snrC, maskC, state.params), baseRefs, {
    algorithmVersion: ALGORITHM_VERSION,
    parameterFingerprint: pf,
    lineageSalt: salt
  });
  emit(state, env, "QualityComputed", { threshold: (quality.content as import("../shared/domain").QualityMap).lowAmplitudeThreshold, paramsFingerprint: pf }, baseRefs.concat(refOf(quality)), [quality.entityId], note);

  const residues = saveEntity(state, env, "ResidueMap", detectResidues(phaseC, quality.content as import("../shared/domain").QualityMap), [refOf(quality), refOf(heads.phase)], {
    algorithmVersion: ALGORITHM_VERSION,
    parameterFingerprint: pf,
    lineageSalt: salt
  });
  emit(state, env, "ResiduesDetected", { residueCount: (residues.content as import("../shared/domain").ResidueMap).residues.length }, [refOf(quality), refOf(residues)], [residues.entityId]);

  const cutNetwork = saveEntity(
    state,
    env,
    "CutNetwork",
    placeCuts(phaseC, quality.content as import("../shared/domain").QualityMap, residues.content as import("../shared/domain").ResidueMap, cutsHistoryC ?? null, state.params, env.seed),
    [refOf(residues), refOf(quality), ...(heads.cuts ? [refOf(heads.cuts)] : [])],
    { algorithmVersion: ALGORITHM_VERSION, parameterFingerprint: pf, lineageSalt: salt }
  );
  emit(state, env, "CutsPlaced", { edgeCount: (cutNetwork.content as import("../shared/domain").CutNetwork).edges.length }, [refOf(residues), refOf(cutNetwork)], [cutNetwork.entityId]);

  const unwrapEntity = saveEntity(
    state,
    env,
    "UnwrapResult",
    unwrap(phaseC, quality.content as import("../shared/domain").QualityMap, cutNetwork.content as import("../shared/domain").CutNetwork, state.params, env.seed),
    [refOf(cutNetwork), refOf(quality), refOf(heads.phase)],
    { algorithmVersion: ALGORITHM_VERSION, parameterFingerprint: pf, lineageSalt: salt }
  );
  emit(state, env, "TreesUnwrapped", { treeCount: (unwrapEntity.content as import("../shared/domain").UnwrapResult).trees.length }, [refOf(cutNetwork), refOf(unwrapEntity)], [unwrapEntity.entityId]);

  const unwrapC = unwrapEntity.content as import("../shared/domain").UnwrapResult;
  const cycles = saveEntity(
    state,
    env,
    "CycleResidualSet",
    evaluateCycles(phaseC, quality.content as import("../shared/domain").QualityMap, cutNetwork.content as import("../shared/domain").CutNetwork, unwrapC.trees[0]),
    [refOf(unwrapEntity), refOf(cutNetwork)],
    { algorithmVersion: ALGORITHM_VERSION, parameterFingerprint: pf, lineageSalt: [salt, unwrapC.trees[0].treeId].filter(Boolean).join("/") }
  );
  emit(state, env, "CyclesEvaluated", machineOfCycles(cycles.content as import("../shared/domain").CycleResidualSet), [refOf(unwrapEntity), refOf(cycles)], [cycles.entityId]);

  const heights: Record<string, Entity> = {};
  for (const tree of unwrapC.trees) {
    const heightContent = convertHeight(tree, wavelengthC, geometryC, calibrationC ?? null, heads.wavelength.digest);
    const hEntity = saveEntity(
      state,
      env,
      "HeightResult",
      heightContent,
      [refOf(unwrapEntity), refOf(heads.wavelength), refOf(heads.geometry), ...(heads.calibration ? [refOf(heads.calibration)] : [])],
      { algorithmVersion: HEIGHT_CHAIN_VERSION, parameterFingerprint: pf, lineageSalt: [salt, tree.treeId].filter(Boolean).join("/") }
    );
    heights[tree.treeId] = hEntity;
    emit(state, env, "HeightConverted", { treeId: tree.treeId, unit: heightContent.unit, calibrationApplied: heightContent.calibrationApplied }, [refOf(unwrapEntity), refOf(heads.wavelength), refOf(hEntity)], [hEntity.entityId]);
  }

  computeFreshness(state);
  return { quality, residues, cutNetwork, unwrap: unwrapEntity, cycles, heights };
}

function machineOfCycles(c: import("../shared/domain").CycleResidualSet): Record<string, unknown> {
  return {
    treeId: c.treeId,
    cycles: c.cycles.length,
    nonClosed: c.cycles.filter((x) => !x.closed).map((x) => x.cycleId),
    acrossCut: c.cycles.filter((x) => x.acrossCut).map((x) => x.cycleId),
    holes: c.cycles.filter((x) => x.componentHole).map((x) => x.cycleId)
  };
}

export function latestDerived(state: State): PipelineResult | null {
  const findLast = (kind: ContentKind) => {
    const list = Object.values(state.entities).filter((e) => e.kind === kind);
    return list[list.length - 1] ?? null;
  };
  const q = findLast("QualityMap");
  if (!q) return null;
  return {
    quality: q,
    residues: findLast("ResidueMap")!,
    cutNetwork: findLast("CutNetwork")!,
    unwrap: findLast("UnwrapResult")!,
    cycles: findLast("CycleResidualSet")!,
    heights: Object.fromEntries(
      Object.values(state.entities)
        .filter((e) => e.kind === "HeightResult")
        .map((e) => [(e.content as import("../shared/domain").HeightResult).treeId, e])
    )
  };
}

// ---------- 人工决定 / 局部锁定 / 撤销 ----------

export function decide(
  state: State,
  env: StoreEnv,
  verdict: ReviewDecision["verdict"],
  reason: string,
  opts: { targetTreeId?: string; targetPixel?: number; parameterChanges?: Record<string, unknown> } = {}
): Entity {
  assertProject(state);
  const prev = Object.values(state.entities).find((e) => e.kind === "ReviewDecision");
  const content: ReviewDecision = {
    kind: "ReviewDecision",
    decisionId: `dec-${shortHash({ verdict, reason, ...opts, at: env.clock.now() }, 10)}`,
    verdict,
    targetTreeId: opts.targetTreeId,
    targetPixel: opts.targetPixel,
    parameterChanges: opts.parameterChanges,
    reason
  };
  const sources: ProvenanceRef[] = [];
  const unwrapHead = latestDerived(state)?.unwrap;
  if (unwrapHead) sources.push(refOf(unwrapHead));
  const entity = saveEntity(state, env, "ReviewDecision", content, sources, { lineageSalt: content.decisionId });
  void prev;
  emit(
    state,
    env,
    verdict === "parameter-adjust" ? "ParameterRevised" : "CandidateDecided",
    { verdict, decisionId: content.decisionId, ...opts },
    sources,
    [entity.entityId],
    reason
  );
  if (verdict === "parameter-adjust" && opts.parameterChanges) {
    reviseParameters(state, env, opts.parameterChanges as Partial<UnwrapParams>, reason);
  }
  return entity;
}

/** 锁定局部解读：同一像素被两棵树/不同整周锁定 => 冲突事件。 */
export function lockLocal(
  state: State,
  env: StoreEnv,
  scopeLabel: string,
  pixels: number[],
  treeId: string,
  pixelIntegerK: Record<string, number>
): Entity {
  assertProject(state);
  const lockId = `lock-${shortHash({ scopeLabel, pixels, treeId, at: env.clock.now() }, 10)}`;
  const existing = Object.values(state.entities)
    .filter((e) => e.kind === "InterpretationLock")
    .map((e) => e.content as InterpretationLock)
    .filter((l) => l.status !== "released");

  const conflicts: string[] = [];
  const pixelSet = new Set(pixels);
  for (const l of existing) {
    const overlap = l.scope.pixels.some((p) => pixelSet.has(p));
    if (overlap && l.treeId !== treeId) {
      conflicts.push(l.lockId);
    } else if (overlap) {
      for (const [pk, kv] of Object.entries(pixelIntegerK)) {
        if (l.pixelIntegerK[pk] !== undefined && l.pixelIntegerK[pk] !== kv) conflicts.push(l.lockId);
      }
    }
  }

  const content: InterpretationLock = {
    kind: "InterpretationLock",
    lockId,
    scope: { pixels: [...pixels].sort((a, b) => a - b), label: scopeLabel },
    treeId,
    pixelIntegerK,
    status: conflicts.length ? "conflict" : "active",
    conflictsWith: conflicts.length ? [...new Set(conflicts)] : undefined
  };
  const unwrapHead = latestDerived(state)?.unwrap;
  const sources = unwrapHead ? [refOf(unwrapHead)] : [];
  const entity = saveEntity(state, env, "InterpretationLock", content, sources, { lineageSalt: lockId });
  emit(state, env, "LocalLocked", { lockId, pixels: content.scope.pixels, treeId, status: content.status }, sources, [entity.entityId], `锁定局部解读：${scopeLabel}`);

  if (conflicts.length) {
    emit(
      state,
      env,
      "LockConflictDetected",
      { lockId, conflictsWith: [...new Set(conflicts)], rule: "同一像素不允许同时采用不同展开树/不同整周解读" },
      sources,
      [entity.entityId, ...conflicts.map((id) => findLockEntity(state, id)?.entityId ?? "")].filter(Boolean),
      "局部锁定冲突"
    );
  }
  return entity;
}

export function resolveLockConflict(state: State, env: StoreEnv, keepLockId: string, reason: string): Entity {
  assertProject(state);
  const keepEntity = findLockEntity(state, keepLockId);
  if (!keepEntity) throw new ActionError("no-lock", `锁定 ${keepLockId} 不存在`);
  const keep = keepEntity.content as InterpretationLock;
  const updatedKeep: InterpretationLock = { ...keep, status: "active", conflictsWith: undefined };
  const newKeep = saveEntity(state, env, "InterpretationLock", updatedKeep, keepEntity.directSources, { lineageSalt: keep.lockId });

  const released: string[] = [];
  for (const id of keep.conflictsWith ?? []) {
    const otherEntity = findLockEntity(state, id);
    if (!otherEntity) continue;
    const other = otherEntity.content as InterpretationLock;
    const releasedLock: InterpretationLock = { ...other, status: "released", conflictsWith: [keep.lockId] };
    saveEntity(state, env, "InterpretationLock", releasedLock, otherEntity.directSources, { lineageSalt: other.lockId });
    released.push(id);
  }
  const decision = decide(state, env, "lock-conflict-resolve", reason, { targetTreeId: keep.treeId });
  emit(state, env, "LockConflictResolved", { keepLockId, released, decisionId: (decision.content as ReviewDecision).decisionId }, [refOf(newKeep)], [newKeep.entityId, ...released.map((id) => findLockEntity(state, id)?.entityId ?? "")]);
  return newKeep;
}

function findLockEntity(state: State, lockId: string): Entity | null {
  const all = Object.values(state.entities)
    .filter((e) => e.kind === "InterpretationLock" && (e.content as InterpretationLock).lockId === lockId)
    .sort((a, b) => a.version - b.version);
  return all[all.length - 1] ?? null;
}

/** 撤销：追加 DecisionUndone 事件 + 新版本决定（supersededBy），不删除历史。 */
export function undoDecision(state: State, env: StoreEnv, decisionId: string, reason: string): Entity {
  assertProject(state);
  const target = Object.values(state.entities)
    .filter((e) => e.kind === "ReviewDecision" && (e.content as ReviewDecision).decisionId === decisionId)
    .sort((a, b) => a.version - b.version)
    .at(-1);
  if (!target) throw new ActionError("no-decision", `决定 ${decisionId} 不存在`);
  const original = target.content as ReviewDecision;
  const undoneContent: ReviewDecision = {
    ...original,
    decisionId: `dec-undo-${shortHash({ decisionId, at: env.clock.now() }, 10)}`,
    reason: `撤销：${reason}（原决定 ${decisionId}）`
  };
  const entity = saveEntity(state, env, "ReviewDecision", undoneContent, target.directSources, { lineageSalt: undoneContent.decisionId });
  emit(state, env, "DecisionUndone", { undoneDecisionId: decisionId, newDecisionId: undoneContent.decisionId }, [refOf(target), refOf(entity)], [target.entityId, entity.entityId], reason);
  return entity;
}

// ---------- 反例档案 ----------

export function saveArchiveBaseline(state: State, env: StoreEnv): void {
  assertProject(state);
  const sourceKinds: SourceKind[] = [
    "WrappedPhaseFrame",
    "AmplitudeFrame",
    "SnrScoreFrame",
    "InvalidMask",
    "Wavelength",
    "IncidenceGeometry",
    "CalibrationSurface",
    "CutEditHistory"
  ];
  const immutableSources = sourceKinds
    .map((k) => headOfKind(state, k))
    .filter((e): e is Entity => !!e)
    .map((e) => ({ kind: e.kind as SourceKind, entityId: e.entityId, digest: e.digest }));
  state.archive.baseline = {
    note: "原相位像素、信噪评分、无效遮罩、波长、入射几何、标定面和切口编辑历史均不可覆盖",
    immutableSources,
    savedAt: env.clock.now()
  };
  emit(state, env, "ArchiveBaselineSaved", { immutable: immutableSources.map((s) => s.kind) }, immutableSources.map((s) => ({ entityId: s.entityId, version: getEntity(state, s.entityId).version, digest: s.digest })), immutableSources.map((s) => s.entityId), "反例档案基线");
}

export function recordCounterScenario(state: State, env: StoreEnv, record: ScenarioRecord): void {
  assertProject(state);
  state.archive.records[record.scenario] = record;
  emit(
    state,
    env,
    "CounterExampleRun",
    {
      scenario: record.scenario,
      changedDirectSource: record.minimalInput.changedDirectSource,
      accepted: record.accepted.length,
      rejected: record.rejected.length,
      affectedScope: record.affectedScope,
      judgements: record.judgements.map((j) => ({ invariant: j.invariant, held: j.held }))
    },
    [],
    [...record.accepted.map((a) => a.entityId), ...record.rejected.map((r) => r.entityId)],
    `反例：${record.scenario}`
  );
}

export function invariantJudgements(): Record<ScenarioRecord["judgements"][number]["invariant"], string> {
  return {
    "no-guess-in-low-amplitude": "低振幅区域不得猜相位",
    "explicit-integer-offset-across-cut": "切口两侧的整周偏移要显式表示",
    "tree-local-consistency-with-path-and-cycle-residual": "不同展开树可得到局部一致解，需保留路径与循环残差",
    "keep-all-legal-candidates": "无法唯一决定时保留全部合法候选"
  };
}

// ---------- 时间旅行：回到任意旧事件，恢复当时依赖版本与可见结论（不改写历史） ----------

/** 返回投影到 seq 时刻的只读视图：事件截断、实体只含当时已存在版本。 */
export function viewAt(state: State, seq: number): { events: EventBase[]; visibleEntities: Entity[]; project: Project | null } {
  if (seq < 0 || seq > state.events.length) throw new ActionError("bad-seq", `seq ${seq} 超出范围 0..${state.events.length}`);
  const created = new Set<string>();
  const events = state.events.slice(0, seq);
  for (const e of events) {
    for (const id of e.affected) created.add(id);
  }
  const visibleEntities = events
    .flatMap((e) => e.affected)
    .filter((id, i, arr) => arr.indexOf(id) === i)
    .map((id) => state.entities[id])
    .filter((e): e is Entity => !!e);
  // 可见结论：按当时顺序应用，族头取当时最新
  return { events, visibleEntities, project: state.project };
}

/** 历史溯源链：从结果追到源输入、计算步骤和人工决定。 */
export function provenanceOf(state: State, entityId: string): { entity: Entity; steps: { entityId: string; kind: ContentKind; version: number; digest: string; summary: string }[] } {
  const entity = getEntity(state, entityId);
  const steps: ReturnType<typeof provenanceOf>["steps"] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    const e = state.entities[id];
    if (!e || seen.has(id)) return;
    seen.add(id);
    steps.push({ entityId: e.entityId, kind: e.kind, version: e.version, digest: e.digest, summary: e.summary });
    for (const ref of e.directSources) walk(ref.entityId);
  };
  walk(entityId);
  return { entity, steps };
}

// ---------- 导出 / 导入（删除本地库后再导入，身份/顺序/来源保持） ----------

export function exportBundle(state: State, env: StoreEnv, caseScript?: Bundle["caseScript"]): Bundle {
  assertProject(state);
  computeFreshness(state);
  const bundle: Bundle = {
    schemaVersion: SCHEMA_VERSION,
    project: state.project,
    events: state.events.map((e) => ({ ...e })),
    entities: Object.values(state.entities).map((e) => ({ ...e })),
    blobs: JSON.parse(JSON.stringify(state.blobs)),
    counterExampleArchive: JSON.parse(JSON.stringify(state.archive)),
    caseScript
  };
  emit(state, env, "ProjectExported", { entities: bundle.entities.length, events: bundle.events.length, blobs: Object.keys(bundle.blobs).length }, [], [], "导出可复查档案包");
  return bundle;
}

/** 校验 bundle：身份、顺序、引用完整且摘要匹配；任何缺失引用 => 损坏，不回退最新版。 */
export function validateBundle(bundle: unknown): asserts bundle is Bundle {
  if (typeof bundle !== "object" || bundle === null) throw new CorruptionError("schema", "bundle 不是对象");
  const b = bundle as Bundle;
  if (b.schemaVersion !== SCHEMA_VERSION) throw new CorruptionError("schema", `schema 版本 ${b.schemaVersion} 不被支持`);
  if (!b.project || !Array.isArray(b.events) || !Array.isArray(b.entities)) throw new CorruptionError("schema", "bundle 缺少 project/events/entities");

  const ids = new Map<string, Entity>();
  for (const e of b.entities) {
    if (ids.has(e.entityId)) throw new CorruptionError("schema", `实体身份重复 ${e.entityId}`);
    const recomputed = digestOf(e.content);
    if (recomputed !== e.digest) throw new CorruptionError("digest-mismatch", `实体 ${e.entityId} 内容摘要不匹配`);
    ids.set(e.entityId, e);
  }

  b.events.forEach((ev, i) => {
    if (ev.seq !== i + 1) throw new CorruptionError("order-broken", `事件顺序断裂：位置 ${i + 1} 的 seq=${ev.seq}`);
  });

  for (const e of b.entities) {
    if (e.parentVersionId && !ids.has(e.parentVersionId))
      throw new CorruptionError("missing-reference", `实体 ${e.entityId} 的父版本 ${e.parentVersionId} 缺失`);
    for (const ref of e.directSources) {
      const target = ids.get(ref.entityId);
      if (!target) throw new CorruptionError("missing-reference", `实体 ${e.entityId} 引用缺失 ${ref.entityId}（不得退回最新版）`);
      if (target.version !== ref.version) throw new CorruptionError("missing-reference", `实体 ${e.entityId} 引用 ${ref.entityId} 版本不是 v${ref.version}`);
      if (target.digest !== ref.digest) throw new CorruptionError("digest-mismatch", `实体 ${e.entityId} 引用 ${ref.entityId} 摘要不符`);
    }
  }
  for (const ev of b.events) {
    for (const ref of ev.refs) {
      const target = ids.get(ref.entityId);
      if (!target) throw new CorruptionError("missing-reference", `事件 ${ev.eventId} 引用缺失 ${ref.entityId}`);
      if (target.digest !== ref.digest) throw new CorruptionError("digest-mismatch", `事件 ${ev.eventId} 引用 ${ref.entityId} 摘要不符`);
    }
    for (const id of ev.affected) {
      if (!ids.has(id)) throw new CorruptionError("missing-reference", `事件 ${ev.eventId} 受影响对象 ${id} 不存在`);
    }
  }
  if (b.counterExampleArchive?.baseline) {
    for (const s of b.counterExampleArchive.baseline.immutableSources) {
      const target = ids.get(s.entityId);
      if (!target || target.digest !== s.digest) throw new CorruptionError("missing-reference", `基线来源 ${s.entityId} 缺失或被改动`);
    }
  }
}

export function importBundle(bundle: Bundle, env: StoreEnv): State {
  validateBundle(bundle);
  const state = createState();
  state.project = bundle.project;
  state.blobs = { ...bundle.blobs };
  state.archive = bundle.counterExampleArchive;
  for (const e of bundle.entities) {
    state.entities[e.entityId] = JSON.parse(JSON.stringify(e));
  }
  for (const e of bundle.entities) {
    const sameLineage = Object.values(state.entities).filter((x) => x.lineageId === e.lineageId);
    if (sameLineage.length === 0) state.lineageHeads[e.lineageId] = e.entityId;
  }
  for (const e of bundle.entities) {
    const head = Object.values(state.entities)
      .filter((x) => x.lineageId === e.lineageId)
      .sort((a, b) => a.version - b.version)
      .at(-1)!;
    state.lineageHeads[e.lineageId] = head.entityId;
    for (const ref of e.directSources) (state.dependencyIndex[ref.digest] ??= new Set()).add(e.entityId);
  }
  state.events = bundle.events.map((e) => ({ ...e }));
  state.project.headSeq = state.events.length;
  computeFreshness(state);
  const lastParamEvent = [...state.events].reverse().find((e) => e.type === "ParameterRevised");
  if (lastParamEvent && lastParamEvent.machine.changes) state.params = { ...state.params, ...(lastParamEvent.machine.changes as object) };
  return state;
}
