/**
 * 反例档案：先封存不可变基线，再对每种情形只改动一个直接来源，
 * 检验影响是否被限制在正确范围。被采纳与未采纳的结果都保留，
 * 三条领域规则的判断依据落成机器可读事件。
 */
import { Store, type VersionRef } from "./store";
import type { ReviewEngine } from "./engine";
import { stableId } from "../domain/hash";
import { unwrap2d, DEFAULT_UNWRAP_PARAMS, type UnwrapResult } from "../domain/unwrap";
import type { GridPayload, InputKind, ScenarioKind, DecisionRule } from "../domain/types";
import { SCENARIOS } from "../domain/types";

export interface ArchiveEntry {
  entryId: string;
  scenario: ScenarioKind;
  changedSource: InputKind;
  minimalRefs: VersionRef[];
  combinedRefs: VersionRef[];
  sharedBlobDigests: string[];
  minimalResultId: string;
  combinedResultId: string;
  adoptedCandidate: string;
  rejectedCandidates: string[];
  diagnostics: string[];
  rules: DecisionRule[];
}

const W = 4, H = 4;

function flat(value: number): number[] {
  return new Array(W * H).fill(value);
}

function grid(values: number[], unit: string): GridPayload {
  return { width: W, height: H, frame: "sensor-pixel", unit, values };
}

/** 每种情形的最小输入：只让目标现象出现。 */
function minimalFixture(scenario: ScenarioKind): { wrapped: number[]; quality: number[]; mask: number[]; changed: InputKind } {
  const ramp = Array.from({ length: W * H }, (_, i) => -Math.PI + ((i % W) / W) * 2 * Math.PI * 0.9);
  switch (scenario) {
    case "phase-crossing-boundary":
      return { wrapped: ramp, quality: flat(15), mask: flat(1), changed: "wrapped_phase" };
    case "low-amplitude-hole": {
      const q = flat(15);
      q[5] = 1; q[6] = 1; q[9] = 1; q[10] = 1;
      return { wrapped: flat(0.3), quality: q, mask: flat(1), changed: "snr_score" };
    }
    case "multi-connected-region": {
      const m = flat(1);
      m[5] = 0; m[6] = 0; m[9] = 0; // 遮罩沟槽切出两个连通区
      return { wrapped: flat(0.2), quality: flat(15), mask: m, changed: "invalid_mask" };
    }
    case "cycle-non-closure": {
      const w = flat(0.1);
      w[6] = 0.1 + 1.8 * Math.PI > Math.PI ? 0.1 + 1.8 * Math.PI - 2 * Math.PI : 0.1 + 1.8 * Math.PI;
      return { wrapped: w, quality: flat(15), mask: flat(1), changed: "wrapped_phase" };
    }
    case "wavelength-version-change":
      return { wrapped: ramp, quality: flat(15), mask: flat(1), changed: "wavelength" };
    case "integer-multi-solution": {
      const q = flat(15);
      // 中央孤岛被低振幅环包围
      q[1] = 2; q[2] = 2; q[4] = 2; q[7] = 2; q[8] = 2; q[11] = 2; q[13] = 2; q[14] = 2;
      return { wrapped: flat(0.4), quality: q, mask: flat(1), changed: "snr_score" };
    }
    case "local-lock-conflict":
      return { wrapped: ramp, quality: flat(15), mask: flat(1), changed: "cut_edit_history" };
  }
}

const RULES_BY_SCENARIO: Record<ScenarioKind, DecisionRule[]> = {
  "phase-crossing-boundary": ["explicit-integer-offsets"],
  "low-amplitude-hole": ["no-guess-low-amplitude"],
  "multi-connected-region": ["keep-paths-and-cycle-residuals"],
  "cycle-non-closure": ["keep-paths-and-cycle-residuals"],
  "wavelength-version-change": ["explicit-integer-offsets"],
  "integer-multi-solution": ["no-guess-low-amplitude", "keep-paths-and-cycle-residuals"],
  "local-lock-conflict": ["explicit-integer-offsets", "keep-paths-and-cycle-residuals"],
};

export function buildCounterexampleArchive(engine: ReviewEngine, store: Store): ArchiveEntry[] {
  // 1) 封存基线：七类输入的当前头版本引用，之后任何修订都不影响此快照
  const baselineHeads = store.listEntities().map((e) => ({
    entityId: e.entityId,
    kind: e.kind,
    versionNo: e.headVersionNo,
    digest: e.headDigest,
  }));
  store.appendEvent("archive.sealed", { baseline: baselineHeads });

  const entries: ArchiveEntry[] = [];
  for (const scenario of SCENARIOS) {
    const fx = minimalFixture(scenario);
    const ns = `arch-${scenario}`;
    // 最小输入与组合输入共享的原始片段（同一内容只存一份，由内容寻址保证）
    const sharedWavelength = { wavelength: { value: 632.8, unit: "nm" }, source: "archive-shared" };
    const sharedGeometry = { incidenceAngle: { value: 30, unit: "deg" }, azimuth: { value: 0, unit: "deg" }, frame: "lab-frame" };
    const sharedCalibration = { reference: "arch-cal", flatness: { value: 10, unit: "nm" }, frame: "surface-normal" };

    const importAs = (suffix: string, wrapped: number[], quality: number[], mask: number[]): VersionRef[] => {
      const refs: VersionRef[] = [];
      refs.push(engine.importInput("wrapped_phase", grid(wrapped, "rad"), `${ns}-${suffix}`, `${ns}-wp-${suffix}`));
      refs.push(engine.importInput("snr_score", grid(quality, "snr_db"), `${ns}-${suffix}`, `${ns}-snr-${suffix}`));
      refs.push(engine.importInput("invalid_mask", grid(mask, "1"), `${ns}-${suffix}`, `${ns}-mask-${suffix}`));
      refs.push(engine.importInput("wavelength", sharedWavelength, `${ns}-${suffix}`, `${ns}-wl-${suffix}`));
      refs.push(engine.importInput("incidence_geometry", sharedGeometry, `${ns}-${suffix}`, `${ns}-geo-${suffix}`));
      refs.push(engine.importInput("calibration_surface", sharedCalibration, `${ns}-${suffix}`, `${ns}-cal-${suffix}`));
      return refs;
    };

    // 最小输入：只呈现目标现象
    const minimalRefs = importAs("min", fx.wrapped, fx.quality, fx.mask);
    // 组合输入：同一现象叠加边界斜坡与中央孔洞（共享片段内容相同，只存一份）
    const combinedWrapped = fx.wrapped.map((v, i) => {
      const r = -Math.PI + ((i % W) / W) * Math.PI * 0.8;
      return Math.abs(v) > Math.abs(r) ? v : r;
    });
    const combinedRefs = importAs("comb", combinedWrapped, fx.quality, fx.mask);

    const runOn = (refs: VersionRef[], tag: string): { resultId: string; result: UnwrapResult } => {
      const wp = store.resolveVersion(refs[0]!.entityId, refs[0]!.versionNo).content as GridPayload;
      const snr = store.resolveVersion(refs[1]!.entityId, refs[1]!.versionNo).content as GridPayload;
      const mask = store.resolveVersion(refs[2]!.entityId, refs[2]!.versionNo).content as GridPayload;
      const result = unwrap2d(
        { width: W, height: H, wrapped: wp.values, quality: snr.values, mask: mask.values },
        DEFAULT_UNWRAP_PARAMS,
      );
      const resultId = stableId("res", { archive: scenario, tag }, result.candidates.length * 7 + W);
      store.putDerived({
        resultId,
        kind: "unwrap",
        algorithmVersion: result.algorithmVersion,
        paramFingerprint: result.paramFingerprint,
        sources: refs,
        payload: result,
      });
      store.appendEvent("unwrap.completed", {
        resultId,
        algorithmVersion: result.algorithmVersion,
        paramFingerprint: result.paramFingerprint,
        sources: refs,
        candidateIds: result.candidates.map((c) => c.candidateId),
        holeCount: result.holes.length,
        cutCount: result.cuts.length,
        cycleCount: result.cycles.length,
        archive: scenario,
        tag,
      });
      return { resultId, result };
    };

    const minimalRun = runOn(minimalRefs, "minimal");
    const combinedRun = runOn(combinedRefs, "combined");

    // 被采纳与未采纳的结果都保留；判断依据落成机器可读事件
    const rules = RULES_BY_SCENARIO[scenario];
    const adopted = minimalRun.result.candidates[0]!.candidateId;
    const rejectedCandidates = minimalRun.result.candidates.slice(1).map((c) => c.candidateId);
    engine.adoptCandidate(minimalRun.resultId, adopted, `反例档案 ${scenario}：采纳主候选`, rules);
    for (const rc of rejectedCandidates) {
      engine.rejectCandidate(minimalRun.resultId, rc, `反例档案 ${scenario}：未采纳，保留备查`, rules);
    }
    for (const d of minimalRun.result.diagnostics) {
      store.appendEvent("diagnostic.raised", { code: `archive:${scenario}`, message: d, related: [minimalRun.resultId], rules });
    }

    const sharedBlobDigests = [sharedWavelength, sharedGeometry, sharedCalibration].map((p) =>
      store.putBlob(p),
    );

    entries.push({
      entryId: stableId("arch", { scenario }, entries.length),
      scenario,
      changedSource: fx.changed,
      minimalRefs,
      combinedRefs,
      sharedBlobDigests,
      minimalResultId: minimalRun.resultId,
      combinedResultId: combinedRun.resultId,
      adoptedCandidate: adopted,
      rejectedCandidates,
      diagnostics: minimalRun.result.diagnostics,
      rules,
    });
  }
  return entries;
}
