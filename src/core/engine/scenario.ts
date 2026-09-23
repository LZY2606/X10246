import { FIXED_SEED } from "../../shared/constants.js";
import type { LedgerEvent, ObjectVersionRecord, ScenarioId, VersionRef } from "../../shared/types.js";
import { frameForScenario, minimalFrame, type FrameSet } from "../cases/frames.js";
import { Ledger } from "../ledger.js";
import { VirtualClock } from "../../shared/clock.js";
import { DatabaseSync } from "node:sqlite";
import { ingestFrame, runPipeline, DEFAULT_PARAMS, type PipelineParams, type PipelineResult } from "./pipeline.js";

export const SCENARIOS: ScenarioId[] = [
  "phase_boundary",
  "low_amplitude_hole",
  "multicomponent",
  "cycle_nonclosure",
  "wavelength_version",
  "integer_ambiguity",
  "lock_conflict",
];

export interface ScenarioRun {
  scenario: ScenarioId;
  ledger: Ledger;
  baseline: PipelineResult;
  minimal: PipelineResult;
  combined: PipelineResult;
  steps: { label: string; events: LedgerEvent[]; affectedObjectIds?: string[] }[];
}

/**
 * 构造一个场景的完整叙事：
 * 1) 基线导入 + 最小输入计算；
 * 2) 参数修订（只产生新版本，不覆盖）；
 * 3) 只影响局部依赖的源数据改动（局部 stale）；
 * 4) 互相冲突的人工决定（锁定冲突）。
 * 组合输入在同一项目内另存一套派生，共享去重的原始片段。
 */
export function runScenario(
  scenario: ScenarioId,
  db = new DatabaseSync(":memory:"),
  clock = new VirtualClock(undefined, 500),
): ScenarioRun {
  const ledger = Ledger.initProject(db, `案例：${scenario}`, {
    projectId: `proj_case_${scenario}`,
    clock,
  });
  const steps: ScenarioRun["steps"] = [];

  const minimalFrameSet = minimalFrame(scenario);
  const minimalRefs = ingestFrame(ledger, minimalFrameSet, { wavelengthNm: 632.8 }, scenario);
  const minimal = runPipeline(ledger, minimalFrameSet, minimalRefs, DEFAULT_PARAMS, scenario);
  steps.push({ label: "基线：最小输入导入与候选产生", events: ledger.events().slice(-ledger.events().length) });

  // 参数修订：整周候选范围/阈值变化 -> 新版本派生结果，父版本保留
  const revisedParams: PipelineParams = { ...DEFAULT_PARAMS, amplitudeThreshold: 0.25, integerCandidateRange: 3 };
  runPipeline(ledger, minimalFrameSet, structuredCloneRefs(minimalRefs), revisedParams, scenario);
  steps.push({
    label: "参数修订：低振幅阈值 0.12→0.25，候选范围 2→3（新版本+父版本）",
    events: ledger.events().filter((e) => e.type === "computation_completed").slice(-8),
  });

  // 组合输入：同一项目导入组合帧（共享片段由内容哈希去重）
  const combinedFrameSet: FrameSet = frameForScenario(scenario);
  const combinedRefs = ingestFrame(ledger, combinedFrameSet, { wavelengthNm: 632.8 }, scenario);
  const combined = runPipeline(ledger, combinedFrameSet, combinedRefs, revisedParams, scenario);
  steps.push({ label: "组合输入：边界组合触发，留下输入片段与受影响对象", events: ledger.events().slice(-12) });

  // 只影响局部依赖的源数据改动：在组合帧上做单像素局部修订
  const changed = localSourceRevision(ledger, scenario, combinedFrameSet, combinedRefs);
  steps.push(changed);

  // 波长版本变更
  if (scenario === "wavelength_version" || scenario === "lock_conflict" || scenario === "phase_boundary") {
    const wl2 = ledger.commitInput({
      kind: "wavelength",
      payload: {
        wavelength: { value: 532.0, unit: { unit: "nm" } },
        channel: "532nm-NdYAG",
      },
      raw: { value: 532.0, unit: "nm" },
      scenario,
      channel: "532nm-NdYAG",
    }).record;
    const ev = ledger.recordWavelengthSwitch({
      from: combinedRefs.wavelength,
      to: { objectId: wl2.objectId, version: wl2.version },
      scenario,
    });
    // 波长切换只使高度链过期（展开相位不依赖波长）
    const staleHeights = combinedRefs.heights.map((r) => r.objectId);
    for (const ref of combinedRefs.heights) {
      ledger.db.prepare("UPDATE object_versions SET status='stale' WHERE object_id=? AND version=?", ref.objectId, ref.version).run();
    }
    steps.push({
      label: "波长版本变更 632.8nm→532nm：仅高度链标 stale，展开结果不受影响",
      events: [ev],
      affectedObjectIds: staleHeights,
    });
  }

  // 整周多解 + 局部锁定冲突
  if (combinedRefs.candidates.length) {
    const candSet = combinedRefs.candidates[0];
    const candPayload = ledger.query(candSet).payload as import("../../shared/types.js").CandidateSetPayload;
    const adopted = candPayload.candidates.find((c) => c.integerOffset === 1) ?? candPayload.candidates[0];
    const rival = candPayload.candidates.find((c) => c.candidateId !== adopted.candidateId) ?? candPayload.candidates[1];
    const adoptEvt = ledger.decideCandidate({
      candidateSetObject: candSet,
      candidateId: adopted.candidateId,
      decision: "adopt",
      scenario,
    });
    rejectIfExists(ledger, candSet, rival, scenario);
    const regionId = `region_${adopted.region[0].x}_${adopted.region[0].y}`;
    ledger.lockRegion({
      regionId,
      candidateId: adopted.candidateId,
      objectId: candSet.objectId,
      version: candSet.version,
      treeId: adopted.treeId,
      note: "审阅者采纳路径一致解",
      scenario,
    });
    let conflictEvent: LedgerEvent | undefined;
    try {
      ledger.lockRegion({
        regionId,
        candidateId: rival.candidateId,
        objectId: candSet.objectId,
        version: candSet.version,
        treeId: rival.treeId,
        note: "竞争解读（无 force，应被拒绝）",
        scenario,
      });
    } catch (e) {
      const name = (e as Error).name;
      if (name !== "LockConflictError") throw e;
    }
    const forced = ledger.lockRegion({
      regionId,
      candidateId: rival.candidateId,
      objectId: candSet.objectId,
      version: candSet.version,
      treeId: rival.treeId,
      note: "冲突解决：显式覆盖锁定，历史保留",
      scenario,
      force: true,
    });
    conflictEvent = forced.conflictEvent;
    steps.push({
      label: "整周多解裁定 + 局部锁定冲突（先冲突拒绝，再显式解决）",
      events: [adoptEvt, ...(conflictEvent ? [conflictEvent, forced.lockEvent] : [forced.lockEvent])],
    });
  }

  // 撤销写入历史
  steps.push({ label: "撤销：冲突解决写入历史但追加 undo 事件", events: [ledger.undo()] });

  return { scenario, ledger, baseline: minimal, minimal, combined, steps };
}

function rejectIfExists(
  ledger: Ledger,
  candSet: VersionRef,
  rival: import("../../shared/types.js").IntegerCandidate | undefined,
  scenario: ScenarioId,
) {
  if (rival)
    ledger.decideCandidate({
      candidateSetObject: candSet,
      candidateId: rival.candidateId,
      decision: "reject",
      rejectReason: "与已采纳展开树的根路径整周基准不一致（全局偏移差），但保留为合法候选",
      scenario,
    });
}

function structuredCloneRefs(refs: PipelineResult["refs"]): PipelineResult["refs"] {
  return JSON.parse(JSON.stringify(refs));
}

/** 局部源修订：仅改动组合帧的一个直接来源像素/阈值，验证过期被限制在正确范围。 */
function localSourceRevision(
  ledger: Ledger,
  scenario: ScenarioId,
  frame: FrameSet,
  refs: PipelineResult["refs"],
): { label: string; events: LedgerEvent[]; affectedObjectIds: string[] } {
  // 直接对遮罩做局部追加版本：只把一个像素改为无效
  const maskValues = new Array(frame.width * frame.height).fill(false);
  maskValues[2 * frame.width + 2] = true;
  const before = new Set(ledger.versions().map((v) => `${v.objectId}#${v.version}`));
  const rec = ledger.commitInput({
    kind: "invalid_mask",
    payload: {
      frame: { width: frame.width, height: frame.height, values: maskValues },
      reason: "local_patch_one_pixel",
    },
    raw: maskValues,
    scenario,
  }).record;
  const n = ledger.markDependentsStale(refs.mask, [`region_2_2`]);
  void before;
  return {
    label: "局部源改动：单像素遮罩修订，仅传递依赖该区域的派生结果过期",
    events: ledger.events().slice(-2),
    affectedObjectIds: [...new Set(ledger.versions().filter((v) => v.status === "stale").map((v) => v.objectId))].slice(0, n + 1),
  };
}

export function listRecords(ledger: Ledger): ObjectVersionRecord[] {
  return ledger.versions();
}

export { FIXED_SEED };
