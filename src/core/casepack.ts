/**
 * 离线案例包「干涉条纹簿：相位展开、支路切口与光学标定分支」。
 * 固定 seed 生成，完整叙事：基线 → 参数修订 → 局部源数据改动 → 冲突人工决定，
 * 重放经过全部七种情形。所有领域量携带单位或坐标基准。
 */
import { mulberry32 } from "../domain/rng";
import type { ReviewEngine } from "./engine";
import type { GridPayload, WavelengthPayload, IncidenceGeometryPayload, CalibrationSurfacePayload, CutEditHistoryPayload, ScenarioKind } from "../domain/types";
import { DEFAULT_UNWRAP_PARAMS } from "../domain/unwrap";

export const CASEPACK_SEED = 20260919;
export const CASEPACK_NAME = "干涉条纹簿：相位展开、支路切口与光学标定分支";

export const GRID_W = 8;
export const GRID_H = 8;

function idx(x: number, y: number): number {
  return y * GRID_W + x;
}

/** 确定性生成基线输入（原始表示，单位原样保留）。 */
export function generateBaselineInputs(): {
  wrapped_phase: GridPayload;
  snr_score: GridPayload;
  invalid_mask: GridPayload;
  wavelength: WavelengthPayload;
  incidence_geometry: IncidenceGeometryPayload;
  calibration_surface: CalibrationSurfacePayload;
  cut_edit_history: CutEditHistoryPayload;
} {
  const rng = mulberry32(CASEPACK_SEED);
  const n = GRID_W * GRID_H;
  const truePhase = new Array<number>(n);
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      // 斜坡 + 中央凸起：多次跨域 ±π 边界（相位跨越边界）
      truePhase[idx(x, y)] =
        1.1 * x + 0.5 * y + 3.0 * Math.exp(-((x - 3.5) ** 2 + (y - 3.5) ** 2) / 4);
    }
  }
  const wrap = (v: number) => {
    let r = v % (2 * Math.PI);
    if (r <= -Math.PI) r += 2 * Math.PI;
    if (r > Math.PI) r -= 2 * Math.PI;
    return r;
  };
  const wrapped = truePhase.map((v) => wrap(v + (rng() - 0.5) * 0.02));
  // 循环不闭合：在 (5,2) 处注入约 1 个整周的残差
  wrapped[idx(5, 2)] = wrap(wrapped[idx(5, 2)]! + 1.9 * Math.PI);

  const snr = new Array<number>(n).fill(18);
  // 低振幅孔洞：中央 2x2
  for (const [x, y] of [[3, 3], [4, 3], [3, 4], [4, 4]]) snr[idx(x, y)] = 2;
  // 孤岛：右下角 (6..7,6..7) 高质，周围一圈低振幅环 → 多连通区 + 整周多解
  for (let x = 5; x <= 7; x++) snr[idx(x, 5)] = 3;
  snr[idx(5, 6)] = 3;
  snr[idx(5, 7)] = 3;

  const mask = new Array<number>(n).fill(1);
  mask[idx(0, 7)] = 0; // 一个无效像素

  return {
    wrapped_phase: { width: GRID_W, height: GRID_H, frame: "sensor-pixel", unit: "rad", values: wrapped },
    snr_score: { width: GRID_W, height: GRID_H, frame: "sensor-pixel", unit: "snr_db", values: snr },
    invalid_mask: { width: GRID_W, height: GRID_H, frame: "sensor-pixel", unit: "1", values: mask },
    wavelength: { wavelength: { value: 632.8, unit: "nm" }, source: "he-ne-laser" },
    incidence_geometry: {
      incidenceAngle: { value: 30, unit: "deg" },
      azimuth: { value: 0, unit: "deg" },
      frame: "lab-frame",
    },
    calibration_surface: {
      reference: "cal-frame-2026-09-01",
      flatness: { value: 12.5, unit: "nm" },
      frame: "surface-normal",
    },
    cut_edit_history: { entries: [] },
  };
}

/** 局部源数据改动：只修复中央孔洞边缘一圈的信噪评分（v2）。 */
export function revisedSnrScore(): GridPayload {
  const base = generateBaselineInputs().snr_score;
  const values = base.values.slice();
  values[idx(2, 3)] = 9;
  values[idx(3, 2)] = 9;
  return { ...base, values };
}

export interface CasepackSummary {
  entityIds: Record<string, string>;
  unwrapResultIds: string[];
  heightResultIds: string[];
  adoptedCandidate: string;
  rejectedCandidates: string[];
  conflictLockIds: string[];
  scenarios: ScenarioKind[];
  replayLog: string[];
}

/** 载入案例包并完整走一遍叙事。 */
export function loadCasePack(engine: ReviewEngine): CasepackSummary {
  const replayLog: string[] = [];
  const inputs = generateBaselineInputs();
  const entityIds: Record<string, string> = {};

  // 1) 初始导入：七类输入齐备，原始表示保留
  for (const [kind, payload] of Object.entries(inputs)) {
    const ref = engine.importInput(kind as keyof typeof inputs & string as never, payload, "干涉条纹簿 v1 初始导入");
    entityIds[kind] = ref.entityId;
    replayLog.push(`import ${kind} -> ${ref.entityId}@v${ref.versionNo}`);
  }
  const baseline = engine.verifyBaseline();
  if (!baseline.ok) throw new Error("案例包基线不完整");
  replayLog.push("baseline verified: 7 类输入齐备且不可覆盖");

  // 2) 首次展开：候选生成（相位跨越边界 / 低振幅孔洞 / 多连通区 / 循环不闭合 / 整周多解）
  engine.triggerScenario("phase-crossing-boundary", [entityIds.wrapped_phase!], ["wrapped_phase@v1"]);
  engine.triggerScenario("low-amplitude-hole", [entityIds.snr_score!], ["snr_score@v1"]);
  engine.triggerScenario("multi-connected-region", [entityIds.snr_score!], ["snr_score@v1"]);
  engine.triggerScenario("cycle-non-closure", [entityIds.wrapped_phase!], ["wrapped_phase@v1"]);
  engine.triggerScenario("integer-multi-solution", [entityIds.snr_score!], ["snr_score@v1"]);
  const run1 = engine.runUnwrap();
  replayLog.push(`unwrap#1 ${run1.resultId}: holes=${run1.result.holes.length} cuts=${run1.result.cuts.length} cycles=${run1.result.cycles.length} candidates=${run1.result.candidates.length}`);

  // 3) 裁定：采纳一个候选，拒绝其余（被采纳与未采纳都保留）
  const adopted = run1.result.candidates[0]!;
  const rejectedCandidates: string[] = [];
  engine.adoptCandidate(run1.resultId, adopted.candidateId, "主候选路径覆盖最大连通区，残差可解释", [
    "explicit-integer-offsets",
    "keep-paths-and-cycle-residuals",
  ]);
  for (const c of run1.result.candidates.slice(1)) {
    engine.rejectCandidate(run1.resultId, c.candidateId, "与主候选在循环残差区域不一致，保留备查", [
      "keep-paths-and-cycle-residuals",
    ]);
    rejectedCandidates.push(c.candidateId);
  }
  const h1 = engine.runHeight(run1.resultId, adopted.candidateId);
  replayLog.push(`height#1 ${h1.heightResultId} (candidate ${adopted.candidateId})`);

  // 4) 参数修订：调整信噪阈值，重跑展开
  engine.adjustParams({ ...DEFAULT_UNWRAP_PARAMS, lowAmplitudeThreshold: 4 }, "审阅者将低振幅阈值 6→4 复核孔洞边界");
  const run2id = engine.projectState().lastUnwrapResultId!;
  replayLog.push(`params adjusted, unwrap#2 ${run2id}`);

  // 5) 局部源数据改动：信噪评分 v2，只使依赖它的结果过期
  engine.triggerScenario("low-amplitude-hole", [entityIds.snr_score!], ["snr_score@v2"]);
  engine.reviseInput(entityIds.snr_score!, revisedSnrScore(), "局部源数据改动：孔洞边缘两点信噪修正");
  replayLog.push("snr_score revised -> v2, 依赖结果标记过期");

  // 6) 波长版本变更：高度链过期
  engine.triggerScenario("wavelength-version-change", [entityIds.wavelength!], ["wavelength@v2"]);
  engine.reviseInput(
    entityIds.wavelength!,
    { wavelength: { value: 632.9, unit: "nm" }, source: "he-ne-laser-recalibrated" },
    "波长版本变更：标定后 632.8nm -> 632.9nm",
  );
  replayLog.push("wavelength revised -> v2, 高度链过期");

  // 7) 冲突的人工决定：两名审阅者对重叠区域锁定不同候选
  engine.triggerScenario("local-lock-conflict", [entityIds.cut_edit_history!], ["review-region-central"]);
  const region = [idx(2, 2), idx(3, 2), idx(2, 3), idx(3, 3)];
  const lockA = engine.acquireLock(region, "operator-a", adopted.candidateId);
  const otherCand = run1.result.candidates[1]!.candidateId;
  const lockB = engine.acquireLock(region, "operator-b", otherCand);
  replayLog.push(`lock conflict: ${lockA.lockId} vs ${lockB.lockId}`);
  // 冲突解决：operator-b 撤销自己的锁定决定（写入历史而非删除）
  const events = engine.projectState();
  void events;
  engine.releaseLock(lockB.lockId);
  replayLog.push(`conflict resolved: ${lockB.lockId} released`);

  return {
    entityIds,
    unwrapResultIds: [run1.resultId, run2id],
    heightResultIds: [h1.heightResultId],
    adoptedCandidate: adopted.candidateId,
    rejectedCandidates,
    conflictLockIds: [lockA.lockId, lockB.lockId],
    scenarios: [
      "phase-crossing-boundary",
      "low-amplitude-hole",
      "multi-connected-region",
      "cycle-non-closure",
      "wavelength-version-change",
      "integer-multi-solution",
      "local-lock-conflict",
    ],
    replayLog,
  };
}
