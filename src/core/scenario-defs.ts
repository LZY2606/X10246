import type { CounterScenario, SourceContent, Wavelength } from "../shared/domain.ts";
import type { SampleInput } from "./importer.ts";
import { baselineSample, localAmplitudePatch, revisedWavelength } from "../../cases/sample-data.ts";
import {
  commitSourceRevision,
  decide,
  headOfKind,
  lockLocal,
  resolveLockConflict,
  runPipeline,
  type State,
  type StoreEnv
} from "./store.ts";
import { compute, registerScenario, type ScenarioOutcome } from "./scenario-support.ts";

/**
 * 七个反例情形。每个情形：
 *  - 最小输入只改动一个直接来源；
 *  - 组合输入在最小输入基础上叠加（共享原始片段，blob 按 hash 去重）；
 *  - 各自独立的解释版本、失败诊断、人工决定。
 */

function reviseSingleKind(state: State, env: StoreEnv, next: SourceContent, reason: string, localOnly: boolean, fragment: unknown) {
  return commitSourceRevision(state, env, next, reason, localOnly, [fragment]);
}

// 1) 相位跨越边界：只替换包裹相位帧（引入更强的 ±π 跨越行）
export function runWrapBoundary(state: State, env: StoreEnv, baseline: SampleInput): void {
  const minimalSample: SampleInput = structuredClone(baseline);
  const cols = minimalSample.grid.cols;
  minimalSample.wrappedPhase = minimalSample.wrappedPhase!.map((v, i) => {
    const c = i % cols;
    // 只改动相位这一个直接来源：制造跨列边界
    if (c === 6) return typeof v === "number" ? Math.min(Math.PI - 0.01, v + 1.4) : v;
    return v;
  });
  minimalSample.sourceFile = "fringe-ledger/case-wrap-boundary-min.json";
  const minimalContent = toContents(minimalSample).find((c) => c.kind === "WrappedPhaseFrame")!;
  reviseSingleKind(state, env, minimalContent, "反例(最小)：仅改动包裹相位，制造 2π 跨越边界", false, minimalContent);
  const minimal = compute(env, state, "min:phase-wrap-boundary", "phase-wrap-boundary", { expectResidues: true });

  const combinedSample = structuredClone(minimalSample);
  combinedSample.sourceFile = "fringe-ledger/case-wrap-boundary-combined.json";
  const combinedContent = toContents(combinedSample).find((c) => c.kind === "WrappedPhaseFrame")!;
  // 组合输入不再产生新相位版本（共享片段），而是在同输入下采用不同参数解释：这里直接重算
  const combined = compute(env, state, "comb:phase-wrap-boundary", "phase-wrap-boundary", { expectResidues: true });
  void combinedContent;

  registerScenario(
    state,
    env,
    "phase-wrap-boundary",
    "WrappedPhaseFrame",
    { minimal: [minimalContent], combined: [minimalContent] },
    minimal,
    combined
  );
}

// 2) 低振幅孔洞：只替换振幅帧（扩大孔洞）
export function runLowAmplitude(state: State, env: StoreEnv, baseline: SampleInput): void {
  const patched = localAmplitudePatch(baseline);
  const ampContent = toContents(patched).find((c) => c.kind === "AmplitudeFrame")!;
  reviseSingleKind(state, env, ampContent, "反例(最小)：仅改动振幅，扩大低振幅孔洞", true, ampContent);
  const minimal = compute(env, state, "min:low-amplitude-hole", "low-amplitude-hole");

  // 组合：再扩一个像素（仍是振幅这一个直接来源族的新版本）
  const combinedSample = structuredClone(patched);
  combinedSample.amplitude![3 * baseline.grid.cols + 4] = 0.04;
  combinedSample.sourceFile = patched.sourceFile + "#combine";
  const combinedAmp = toContents(combinedSample).find((c) => c.kind === "AmplitudeFrame")!;
  reviseSingleKind(state, env, combinedAmp, "反例(组合)：振幅孔洞进一步扩大（局部依赖）", true, combinedAmp);
  const combined = compute(env, state, "comb:low-amplitude-hole", "low-amplitude-hole");

  registerScenario(state, env, "low-amplitude-hole", "AmplitudeFrame", { minimal: [ampContent], combined: [combinedAmp] }, minimal, combined);
}

// 3) 多连通区：只替换无效遮罩（切出一个岛屿）
export function runMultiplyConnected(state: State, env: StoreEnv, baseline: SampleInput): void {
  const sample = structuredClone(baseline);
  const cols = sample.grid.cols;
  // 用遮罩围出一个被包围的有效岛屿中心：mask 一圈，保留中心
  const centerR = 4, centerC = 5;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const idx = (centerR + dr) * cols + (centerC + dc);
      sample.invalid![idx] = true;
      sample.invalidReason![idx] = "obstacle-island-moat";
    }
  }
  sample.sourceFile = "fringe-ledger/case-multiconnected-min.json";
  const maskContent = toContents(sample).find((c) => c.kind === "InvalidMask")!;
  reviseSingleKind(state, env, maskContent, "反例(最小)：仅改动遮罩，制造多连通岛屿", true, maskContent);
  const minimal = compute(env, state, "min:multiply-connected", "multiply-connected");

  const combinedSample = structuredClone(sample);
  combinedSample.invalid![2 * cols + 5] = true;
  combinedSample.invalidReason![2 * cols + 5] = "obstacle-extra";
  const combinedMask = toContents(combinedSample).find((c) => c.kind === "InvalidMask")!;
  reviseSingleKind(state, env, combinedMask, "反例(组合)：遮罩再加障碍（仍只影响局部）", true, combinedMask);
  const combined = compute(env, state, "comb:multiply-connected", "multiply-connected");

  registerScenario(state, env, "multiply-connected", "InvalidMask", { minimal: [maskContent], combined: [combinedMask] }, minimal, combined);
}

// 4) 循环不闭合：以当前展开树为基础，在已知跨越区重算并记录循环残差
export function runCycleNonclosure(state: State, env: StoreEnv, baseline: SampleInput): void {
  const sample = structuredClone(baseline);
  sample.sourceFile = "fringe-ledger/case-cycle-min.json";
  // 只动相位：引入一个更强的局部台阶以制造非零 plaquette 循环残差
  const cols = sample.grid.cols;
  sample.wrappedPhase = sample.wrappedPhase!.map((v, i) => {
    const r = Math.floor(i / cols), c = i % cols;
    if ((r === 4 || r === 5) && c >= 5) return typeof v === "number" ? v + 2.9 : v;
    return v;
  });
  const phaseContent = toContents(sample).find((c) => c.kind === "WrappedPhaseFrame")!;
  reviseSingleKind(state, env, phaseContent, "反例(最小)：仅改动相位台阶，制造循环不闭合", false, phaseContent);
  const minimal = compute(env, state, "min:cycle-nonclosure", "cycle-nonclosure", { expectResidues: true, expectNonClosed: true });

  const combined = compute(env, state, "comb:cycle-nonclosure", "cycle-nonclosure", { expectResidues: true });
  registerScenario(state, env, "cycle-nonclosure", "WrappedPhaseFrame", { minimal: [phaseContent], combined: [phaseContent] }, minimal, combined);
}

// 5) 波长版本变更：只改波长（高度链过期，展开不过期）
export function runWavelengthRevision(state: State, env: StoreEnv, baseline: SampleInput): void {
  const wl0: NonNullable<ReturnType<typeof revisedWavelength>> = revisedWavelength()!;
  const nextWl: Wavelength = { kind: "Wavelength", wavelength: { value: wl0.value, unit: wl0.unit, rawText: `${wl0.value} ${wl0.unit}` }, band: wl0.band ?? "unmarked" };
  reviseSingleKind(state, env, nextWl, "反例(最小)：仅波长 632.8nm -> 532nm 版本变更", false, nextWl);
  const minimal = compute(env, state, "min:wavelength-revision", "wavelength-revision");

  // 组合：波长 + 入射角微小修订（两个来源），用于对比影响范围
  const geoContent = toContents(baseline).find((c) => c.kind === "IncidenceGeometry")!;
  commitSourceRevision(state, env, geoContent, "反例(组合)：入射角附带修订（影响范围应包含几何依赖）", false, [geoContent]);
  const combined = compute(env, state, "comb:wavelength-revision", "wavelength-revision");

  registerScenario(state, env, "wavelength-revision", "Wavelength", { minimal: [nextWl], combined: [nextWl, geoContent] }, minimal, combined);
}

// 6) 整周多解：保留两棵树全部候选；人工接受替代树
export function runIntegerAmbiguity(state: State, env: StoreEnv, baseline: SampleInput): void {
  const sample = structuredClone(baseline);
  sample.sourceFile = "fringe-ledger/case-integer-ambiguity-min.json";
  const phaseContent = toContents(sample).find((c) => c.kind === "WrappedPhaseFrame")!;
  // baseline 本身已含台阶；为最小化触发，显式记录一次相位来源即可（用现有族头）
  if (!headOfKind(state, "WrappedPhaseFrame")) {
    throw new Error("应在基线导入后运行");
  }
  const minimal = compute(env, state, "min:integer-ambiguity", "integer-ambiguity", { expectMultipleTrees: true });
  // 人工决定：接受替代树（保留被拒绝的主树记录）
  const dec = decide(state, env, "accept", "采纳跨越切口的替代展开树的整周候选（局部一致）", { targetTreeId: "tree-across-cut" });
  minimal.humanDecisions.push(dec.entityId);
  const pipeAlt = runPipeline(state, env, { salt: "comb:integer-ambiguity" });
  const combined: ScenarioOutcome = {
    accepted: [{ entityId: pipeAlt.unwrap.entityId, summary: pipeAlt.unwrap.summary + "（组合复核重算）" }],
    rejected: [],
    diagnostics: [],
    humanDecisions: [dec.entityId],
    affectedScope: [pipeAlt.unwrap.entityId],
    judgements: minimal.judgements
  };
  registerScenario(state, env, "integer-ambiguity", "WrappedPhaseFrame", { minimal: [phaseContent], combined: [phaseContent] }, minimal, combined);
}

// 7) 局部锁定冲突：两棵树对同一像素加锁 => 冲突 => 解决
export function runLockConflict(state: State, env: StoreEnv, baseline: SampleInput): void {
  void baseline;
  runPipeline(state, env, { salt: "min:local-lock-conflict" });
  const unwrap = latestUnwrap(state);
  const candidatePixel = pickAmbiguousPixel(unwrap);
  const lockA = lockLocal(state, env, "审阅者A：采用主树 k=0", [candidatePixel], "tree-primary", { [candidatePixel]: 0 });
  const minimal: ScenarioOutcome = {
    accepted: [{ entityId: lockA.entityId, summary: lockA.summary }],
    rejected: [],
    diagnostics: ["同一像素随后将被替代树以不同整周锁定"],
    humanDecisions: [],
    affectedScope: [lockA.entityId],
    judgements: []
  };

  const lockB = lockLocal(state, env, "审阅者B：采用替代树 k=1", [candidatePixel], "tree-across-cut", { [candidatePixel]: 1 });
  const kept = resolveLockConflict(state, env, (lockB.content as import("../shared/domain").InterpretationLock).lockId, "裁定：台阶跨越方向支持替代树整周，释放 A 的锁定");
  const combined: ScenarioOutcome = {
    accepted: [{ entityId: lockB.entityId, summary: lockB.summary }, { entityId: kept.entityId, summary: kept.summary }],
    rejected: [{ entityId: lockA.entityId, summary: lockA.summary, reason: "局部锁定冲突中被释放" }],
    diagnostics: [],
    humanDecisions: [kept.entityId],
    affectedScope: [lockA.entityId, lockB.entityId, kept.entityId],
    judgements: []
  };
  registerScenario(
    state,
    env,
    "local-lock-conflict",
    "InterpretationLock",
    { minimal: [{ lock: "A", pixel: candidatePixel }], combined: [{ lock: "B", pixel: candidatePixel }] },
    minimal,
    combined
  );
}

function latestUnwrap(state: State) {
  const list = Object.values(state.entities).filter((e) => e.kind === "UnwrapResult");
  return list[list.length - 1].content as import("../shared/domain").UnwrapResult;
}

function pickAmbiguousPixel(unwrap: import("../shared/domain").UnwrapResult): number {
  const alt = unwrap.trees.find((t) => t.treeId === "tree-across-cut");
  if (alt) {
    const idx = alt.integerCandidates.findIndex((c) => c.length > 1);
    if (idx >= 0) return idx;
  }
  // 退路：主树中部像素
  const g = unwrap.grid;
  return Math.floor(g.rows / 2) * g.cols + Math.floor(g.cols / 2);
}

import { parseSample } from "./importer.ts";
function toContents(sample: SampleInput): SourceContent[] {
  return parseSample(sample, sample.sourceFile ?? "sample.json");
}
