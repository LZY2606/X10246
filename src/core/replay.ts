import type { Bundle, CaseScript, CounterScenario } from "../shared/domain.ts";
import { createClock, type Clock } from "./rng.ts";
import {
  createProject,
  createState,
  exportBundle,
  saveArchiveBaseline,
  reviseParameters,
  decide,
  undoDecision,
  type State,
  type StoreEnv
} from "./store.ts";
import { CASE_SEED, CASE_START, commitSample } from "./scenario-support.ts";
import { baselineSample, revisedParams } from "../../cases/sample-data.ts";
import {
  runCycleNonclosure,
  runIntegerAmbiguity,
  runLockConflict,
  runLowAmplitude,
  runMultiplyConnected,
  runWavelengthRevision,
  runWrapBoundary
} from "./scenario-defs.ts";

export function buildCaseScript(): CaseScript {
  return {
    id: "interfero-ledger-case-v1",
    title: "干涉条纹簿：相位展开、支路切口与光学标定分支",
    description:
      "光学实验室导入包裹相位/振幅/遮罩/标定帧，审阅二维相位展开的切口、整周候选与表面高度。重放覆盖相位跨越边界、低振幅孔洞、多连通区、循环不闭合、波长版本变更、整周多解与局部锁定冲突。",
    steps: [
      { id: "import", title: "1. 初始导入", narrative: "导入包裹相位、振幅、信噪、遮罩、波长、入射几何、标定面与切口编辑历史。", action: { type: "import" }, expectedAffected: ["WrappedPhaseFrame", "AmplitudeFrame", "SnrScoreFrame", "InvalidMask", "Wavelength", "IncidenceGeometry", "CalibrationSurface", "CutEditHistory"] },
      { id: "baseline", title: "2. 核对不可覆盖基线", narrative: "审阅者核对八类原相位/证据/标定输入，并保存反例档案基线。", action: { type: "verify-baseline" }, expectedAffected: ["ArchiveBaselineSaved"] },
      { id: "triggers", title: "3. 触发边界组合反例", narrative: "依次只改动一个直接来源：相位跨越边界、多连通区、循环不闭合。", action: { type: "trigger", scenarios: ["phase-wrap-boundary", "multiply-connected", "cycle-nonclosure"] }, expectedAffected: [] },
      { id: "low-amp", title: "4. 低振幅分支", narrative: "检验低振幅区域不猜相位、切口整周显式、不同展开树与循环残差，保留全部合法候选。", action: { type: "branch-low-amplitude" }, expectedAffected: [] },
      { id: "lock", title: "5. 锁定与冲突", narrative: "对同一像素分别按两棵树上锁，制造并解决局部锁定冲突。", action: { type: "lock", pixels: [], treeId: "tree-primary" }, expectedAffected: [] },
      { id: "review", title: "6. 最终复核", narrative: "并排查看包裹/展开相位、质量图、切口网络、循环残差与高度转换链，锁定局部解。", action: { type: "final-review" }, expectedAffected: [] },
      { id: "undo", title: "7. 撤销与时间旅行", narrative: "撤销一次人工决定，并回到旧事件查看当时结论（不被最新结果覆盖）。", action: { type: "undo", eventSeq: 0 }, expectedAffected: [] }
    ]
  };
}

export interface ReplayResult {
  state: State;
  env: StoreEnv;
  bundle: Bundle;
  checkpoints: Record<string, number>;
}

/** 完整重放案例（固定 seed + 虚拟时间）。 */
export function replayCase(): ReplayResult {
  const env = { clock: createClock(CASE_START), seed: CASE_SEED };
  return replayWithState(env);
}

export function replayWithState(envInput: StoreEnv & { clock: Clock }): ReplayResult {
  const env: StoreEnv & { clock: Clock } = envInput;
  const state = createState();
  const checkpoints: Record<string, number> = {};
  const baseline = baselineSample(CASE_SEED);

  createProject(state, env, "干涉条纹簿：相位展开、支路切口与光学标定分支");
  env.clock.tick(1000);

  commitSample(state, env, baseline);
  checkpoints.import = state.events.length;
  env.clock.tick(1000);

  saveArchiveBaseline(state, env);
  checkpoints.baseline = state.events.length;
  env.clock.tick(1000);

  // 一次参数修订
  reviseParameters(state, env, revisedParams(), "缩短最大支路切口长度，观察配对变化");
  env.clock.tick(1000);

  // 七个情形
  runWrapBoundary(state, env, baseline);
  env.clock.tick(500);
  runMultiplyConnected(state, env, baseline);
  env.clock.tick(500);
  runCycleNonclosure(state, env, baseline);
  env.clock.tick(500);
  runLowAmplitude(state, env, baseline);
  env.clock.tick(500);
  runWavelengthRevision(state, env, baseline);
  env.clock.tick(500);
  runIntegerAmbiguity(state, env, baseline);
  env.clock.tick(500);
  runLockConflict(state, env, baseline);
  env.clock.tick(500);
  checkpoints.counterExamples = state.events.length;

  // 互相冲突的人工决定 + 撤销
  const dec = decide(state, env, "reject", "复核中暂时否决替代树（随后撤销）", { targetTreeId: "tree-across-cut" });
  env.clock.tick(500);
  undoDecision(state, env, (dec.content as import("../shared/domain").ReviewDecision).decisionId, "审阅者改判：替代树证据成立");
  env.clock.tick(500);
  checkpoints.final = state.events.length;

  const bundle = exportBundle(state, env, buildCaseScript());
  return { state, env, bundle, checkpoints };
}
