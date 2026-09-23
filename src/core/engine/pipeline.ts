import { ALGORITHM_VERSIONS } from "../../shared/constants.js";
import type {
  CandidateSetPayload,
  CutEdge,
  IntegerCandidate,
  SnrScorePayload,
  VersionRef,
  WavelengthPayload,
  IncidenceGeometryPayload,
  CalibrationPlanePayload,
  CutEditHistoryPayload,
} from "../../shared/types.js";
import { idx } from "../domain/grid.js";
import { buildHeightField } from "../domain/height.js";
import { computeBranchCuts, computeQualityMap, computeResidues } from "../domain/residues.js";
import {
  assembleUnwrapped,
  buildUnwrapTree,
  computeCycleResiduals,
  connectedComponents,
  type BuiltTree,
} from "../domain/unwrap.js";
import { importInput } from "../import/importer.js";
import { Ledger } from "../ledger.js";
import type { FrameSet } from "../cases/frames.js";
import { regionId, regionListId } from "../../shared/ids.js";

export interface PipelineParams {
  amplitudeThreshold: number;
  snrThreshold: number;
  maxTreesPerComponent: number;
  integerCandidateRange: number;
}

export const DEFAULT_PARAMS: PipelineParams = {
  amplitudeThreshold: 0.12,
  snrThreshold: 0.2,
  maxTreesPerComponent: 3,
  integerCandidateRange: 2,
};

export interface PipelineResult {
  refs: {
    phase: VersionRef;
    amplitude: VersionRef;
    snr: VersionRef;
    mask: VersionRef;
    wavelength: VersionRef;
    geometry: VersionRef;
    calibration: VersionRef;
    cutHistory: VersionRef;
    residue?: VersionRef;
    cuts?: VersionRef;
    quality?: VersionRef;
    trees: VersionRef[];
    cycles: VersionRef[];
    unwrapped: VersionRef[];
    heights: VersionRef[];
    candidates: VersionRef[];
  };
  trees: { ref: VersionRef; built: BuiltTree; componentId: string }[];
  params: PipelineParams;
}

export interface CalibrationSetup {
  wavelengthNm: number;
  channel?: string;
  incidenceAngleDeg?: number;
  arrangement?: IncidenceGeometryPayload["arrangement"];
  passFactor?: number;
  anchors?: { x: number; y: number; physical: { x: number; y: number; z: number } }[];
  importedCutEdits?: CutEditHistoryPayload["edits"];
}

/** 把样例帧导入账本（包裹相位/振幅/遮罩/信噪 + 波长/几何/标定/切口史）。 */
export function ingestFrame(
  ledger: Ledger,
  frame: FrameSet,
  setup: CalibrationSetup,
  scenario?: import("../../shared/types.js").ScenarioId,
): PipelineResult["refs"] {
  const phaseImport = importInput({
    kind: "wrapped_phase",
    width: frame.width,
    height: frame.height,
    encoding: "float_rad_pmpi",
    values: frame.phase,
  });
  const phase = ledger.commitInput({
    kind: "wrapped_phase",
    payload: phaseImport.payload,
    raw: frame.phase,
    diagnostics: phaseImport.diagnostics,
    scenario,
  }).record;
  const ampImport = importInput({
    kind: "amplitude",
    width: frame.width,
    height: frame.height,
    encoding: "float",
    values: frame.amplitude,
    amplitudeUnit: "a.u.",
  });
  const amplitude = ledger.commitInput({
    kind: "amplitude",
    payload: ampImport.payload,
    raw: frame.amplitude,
    diagnostics: ampImport.diagnostics,
    scenario,
  }).record;
  // 信噪评分：从振幅派生但提交后即冻结为独立不可变输入实体
  const snrValues = frame.amplitude.map((a) => Math.min(1, 0.2 + a * 0.8));
  const snrImport = importInput({
    kind: "snr_score",
    width: frame.width,
    height: frame.height,
    encoding: "float_dimensionless",
    values: snrValues,
    threshold: DEFAULT_PARAMS.snrThreshold,
  });
  const snr = ledger.commitInput({
    kind: "snr_score",
    payload: snrImport.payload as SnrScorePayload,
    raw: snrValues,
    diagnostics: snrImport.diagnostics,
    scenario,
  }).record;
  const maskImport = importInput({
    kind: "invalid_mask",
    width: frame.width,
    height: frame.height,
    values: frame.mask.map((m) => (m ? 1 : 0)),
    reason: "scenario_mask",
  });
  const mask = ledger.commitInput({
    kind: "invalid_mask",
    payload: maskImport.payload,
    raw: frame.mask,
    diagnostics: maskImport.diagnostics,
    scenario,
  }).record;
  const wlImport = importInput({
    kind: "wavelength",
    channel: setup.channel ?? "632.8nm-HeNe",
    value: setup.wavelengthNm,
    unit: "nm",
  });
  const wavelength = ledger.commitInput({
    kind: "wavelength",
    payload: wlImport.payload as WavelengthPayload,
    raw: { value: setup.wavelengthNm, unit: "nm" },
    diagnostics: wlImport.diagnostics,
    scenario,
    channel: setup.channel ?? "632.8nm-HeNe",
  }).record;
  const geoImport = importInput({
    kind: "incidence_geometry",
    arrangement: setup.arrangement ?? "out_of_plane_normal_incidence",
    incidenceAngleDeg: setup.incidenceAngleDeg,
    passFactor: setup.passFactor,
  });
  const geometry = ledger.commitInput({
    kind: "incidence_geometry",
    payload: geoImport.payload as IncidenceGeometryPayload,
    raw: setup,
    diagnostics: geoImport.diagnostics,
    scenario,
  }).record;
  const anchors = setup.anchors ?? [
    { x: 0, y: 0, physical: { x: 0, y: 0, z: 0 } },
    { x: frame.width - 1, y: frame.height - 1, physical: { x: frame.width - 1, y: frame.height - 1, z: 0 } },
  ];
  const calImport = importInput({ kind: "calibration_plane", lengthUnit: "nm", anchors });
  const calibration = ledger.commitInput({
    kind: "calibration_plane",
    payload: calImport.payload as CalibrationPlanePayload,
    raw: anchors,
    diagnostics: calImport.diagnostics,
    scenario,
  }).record;
  const cutImport = importInput({
    kind: "cut_edit_history",
    note: "初始空切口编辑历史（不可覆盖，仅追加）",
    edits: setup.importedCutEdits ?? [],
  });
  const cutHistory = ledger.commitInput({
    kind: "cut_edit_history",
    payload: cutImport.payload as CutEditHistoryPayload,
    raw: setup.importedCutEdits ?? [],
    diagnostics: cutImport.diagnostics,
    scenario,
  }).record;

  const refOf = (r: { objectId: string; version: number }): VersionRef => ({ objectId: r.objectId, version: r.version });
  return {
    phase: refOf(phase),
    amplitude: refOf(amplitude),
    snr: refOf(snr),
    mask: refOf(mask),
    wavelength: refOf(wavelength),
    geometry: refOf(geometry),
    calibration: refOf(calibration),
    cutHistory: refOf(cutHistory),
    trees: [],
    cycles: [],
    unwrapped: [],
    heights: [],
    candidates: [],
  };
}

/** 全量派生计算（确定性）：残差 → 切口 → 质量 → 分量 → 多树展开 → 循环残差 → 候选 → 高度链。 */
export function runPipeline(
  ledger: Ledger,
  frame: FrameSet,
  refs: PipelineResult["refs"],
  params: PipelineParams = DEFAULT_PARAMS,
  scenario?: import("../../shared/types.js").ScenarioId,
): PipelineResult {
  const w = frame.width;
  const h = frame.height;
  const phasePayload = ledger.query(refs.phase).payload as import("../../shared/types.js").WrappedPhasePayload;
  const ampPayload = ledger.query(refs.amplitude).payload as import("../../shared/types.js").AmplitudePayload;
  const snrPayload = ledger.query(refs.snr).payload as SnrScorePayload;
  const maskPayload = ledger.query(refs.mask).payload as import("../../shared/types.js").InvalidMaskPayload;
  const wlPayload = ledger.query(refs.wavelength).payload as WavelengthPayload;
  const geoPayload = ledger.query(refs.geometry).payload as IncidenceGeometryPayload;
  const cutPayload = ledger.query(refs.cutHistory).payload as CutEditHistoryPayload;

  const phase = phasePayload.frame.values;
  const amplitude = ampPayload.frame.values;
  const snr = snrPayload.frame.values;
  const mask = maskPayload.frame.values;
  const ampMax = Math.max(1e-9, ...amplitude.filter((v): v is number => v !== null));

  // 低振幅像素：禁止参与展开（禁止猜相位）
  const lowAmp = amplitude.map((v) => v === null || v < params.amplitudeThreshold * ampMax);
  const valid = new Array(w * h).fill(false).map((_, i) => phase[i] !== null && !mask[i] && !lowAmp[i]);

  const fp = parameterFingerprint(params);
  const baseSources = [refs.phase, refs.amplitude, refs.snr, refs.mask];

  const residue = ledger.commitDerived({
    kind: "residue_map",
    payload: computeResidues({
      width: w,
      height: h,
      phase,
      amplitude,
      mask,
      ampMax,
      amplitudeThreshold: params.amplitudeThreshold,
    }),
    sources: baseSources,
    algorithmVersion: ALGORITHM_VERSIONS.residue,
    params,
    scenario,
  }).record;
  refs.residue = { objectId: residue.objectId, version: residue.version };

  const importedEdges: CutEdge[] = cutPayload.edits
    .filter((e) => e.action === "add_cut")
    .map((e, i) => ({
      edgeId: `imported_${String(i).padStart(4, "0")}_${e.editId}`,
      a: e.from,
      b: e.to,
      integerOffset: e.integerOffset,
      source: "imported_history" as const,
      diagnostic: e.integerOffset === null ? "导入切口缺少显式整周偏移" : undefined,
    }));

  const cutsRec = ledger.commitDerived({
    kind: "branch_cut_network",
    payload: computeBranchCuts(ledger.query(refs.residue as VersionRef).payload as import("../../shared/types.js").ResidueMapPayload, importedEdges, fp, w, h).network,
    sources: [refs.residue as VersionRef, refs.cutHistory],
    algorithmVersion: ALGORITHM_VERSIONS.branchCut,
    params,
    scenario,
  }).record;
  refs.cuts = { objectId: cutsRec.objectId, version: cutsRec.version };

  const qualityRec = ledger.commitDerived({
    kind: "quality_map",
    payload: computeQualityMap(w, h, amplitude, snr, mask, ledger.query(refs.residue as VersionRef).payload as import("../../shared/types.js").ResidueMapPayload, params.amplitudeThreshold),
    sources: [refs.amplitude, refs.snr, refs.mask, refs.residue as VersionRef],
    algorithmVersion: ALGORITHM_VERSIONS.quality,
    params,
    scenario,
  }).record;
  refs.quality = { objectId: qualityRec.objectId, version: qualityRec.version };

  const qualityMap = new Map<number, number>();
  for (const c of (ledger.query(refs.quality as VersionRef).payload as import("../../shared/types.js").QualityMapPayload).cells)
    qualityMap.set(idx(w, c.x, c.y), c.score);

  const network = ledger.query(refs.cuts as VersionRef).payload as import("../../shared/types.js").BranchCutNetworkPayload;
  const ui: UnwrapInputsLike = {
    width: w,
    height: h,
    phase,
    valid,
    quality: qualityMap,
    network,
    parameterFingerprint: fp,
  };

  const comps = connectedComponents(w, h, valid);
  const pixelComponent = new Map<number, string>();
  for (const c of comps) for (const p of c.pixels) pixelComponent.set(idx(w, p.x, p.y), c.id);

  const builtTrees: PipelineResult["trees"] = [];
  const candidateSets: VersionRef[] = [];

  comps.forEach((comp, ci) => {
    // 每个连通分量保留多种子树（局部一致解），数量受参数限制
    const rootChoices = chooseRoots(w, comp.pixels, qualityMap, params.maxTreesPerComponent);
    rootChoices.forEach((root, ti) => {
      const treeId = `tree_c${ci}_t${ti}`;
      const built = buildUnwrapTree(ui, root, treeId);
      const scope = comp.pixels.map((p) => regionId(p.x, p.y));
      const treeRec = ledger.commitDerived({
        kind: "unwrapped_tree",
        payload: built.tree,
        sources: [refs.phase, refs.cuts as VersionRef, refs.quality as VersionRef, refs.mask, refs.amplitude],
        algorithmVersion: ALGORITHM_VERSIONS.unwrap,
        params: { ...params, root, treeId },
        scopeRegions: scope,
        scenario,
        rationale: {
          rule: "TREE_LOCAL_CONSISTENCY_WITH_CYCLE_RESIDUAL",
          evidence: { treeId, root, covered: built.tree.covered.length },
          accepted: true,
        },
      }).record;
      const treeRef = { objectId: treeRec.objectId, version: treeRec.version };
      refs.trees.push(treeRef);

      const cyclesRec = ledger.commitDerived({
        kind: "cycle_residuals",
        payload: computeCycleResiduals(ui, built, pixelComponent),
        sources: [treeRef, refs.phase, refs.cuts as VersionRef],
        algorithmVersion: ALGORITHM_VERSIONS.cycle,
        params: { treeId },
        scopeRegions: scope,
        scenario,
      }).record;
      const cyclesRef = { objectId: cyclesRec.objectId, version: cyclesRec.version };
      refs.cycles.push(cyclesRef);

      const unwrappedPayload = assembleUnwrapped(
        w,
        h,
        phase,
        valid,
        (x, y) => (mask[idx(w, x, y)] ? "invalid_mask" : lowAmp[idx(w, x, y)] ? "low_amplitude" : "isolated_component"),
        built,
        pixelComponent,
        fp,
      );
      const unwrapRec = ledger.commitDerived({
        kind: "unwrapped_phase",
        payload: unwrappedPayload,
        sources: [treeRef, cyclesRef, refs.phase, refs.mask, refs.amplitude],
        algorithmVersion: ALGORITHM_VERSIONS.unwrap,
        params: { treeId },
        scopeRegions: scope,
        scenario,
        rationale: {
          rule: "NO_GUESS_LOW_AMPLITUDE",
          evidence: {
            treeId,
            unknownPixels: unwrappedPayload.pixels.filter((p) => p.unwrappedRad === null).length,
          },
          accepted: true,
        },
      }).record;
      const unwrappedRef = { objectId: unwrapRec.objectId, version: unwrapRec.version };
      refs.unwrapped.push(unwrappedRef);

      const heightRec = ledger.commitDerived({
        kind: "height_field",
        payload: buildHeightField({
          unwrapped: unwrappedPayload,
          wavelength: wlPayload,
          geometry: geoPayload,
          wavelengthRef: refs.wavelength,
          geometryRef: refs.geometry,
          calibrationRef: refs.calibration,
        }),
        sources: [unwrappedRef, refs.wavelength, refs.geometry, refs.calibration],
        algorithmVersion: ALGORITHM_VERSIONS.height,
        params: { treeId },
        scopeRegions: scope,
        scenario,
      }).record;
      refs.heights.push({ objectId: heightRec.objectId, version: heightRec.version });

      builtTrees.push({ ref: treeRef, built, componentId: comp.id });

      // 整周多解：对树内任一边界跨越邻接生成 -k..+k 合法候选（局部一致）
      const boundarySteps = built.tree.paths.filter((s) => s.integerJump !== 0);
      if (boundarySteps.length) {
        const step = boundarySteps[0];
        const region = [step.from, step.to];
        const candidates: IntegerCandidate[] = [];
        for (let k = -params.integerCandidateRange; k <= params.integerCandidateRange; k++) {
          candidates.push({
            candidateId: `cand_${step.to.x}_${step.to.y}_k${k >= 0 ? "p" : "m"}${Math.abs(k)}`,
            region,
            integerOffset: k,
            status: k === step.integerJump ? "legal" : "legal",
            consistencyEvidence:
              k === step.integerJump
                ? `与 ${treeId} 从根 ${root.x},${root.y} 出发的路径积分一致`
                : `整周常数平移：与 ${treeId} 局部一致，但相对根的全局偏移差 ${k - step.integerJump}`,
            treeId,
          });
        }
        const payload: CandidateSetPayload = {
          ambiguityId: `amb_${step.to.x}_${step.to.y}`,
          scenario: scenario ?? "integer_ambiguity",
          candidates,
          resolution: params.integerCandidateRange > 0 ? "ambiguous" : "unique",
        };
        const candRec = ledger.commitDerived({
          kind: "candidate_set",
          payload,
          sources: [treeRef, unwrappedRef],
          algorithmVersion: ALGORITHM_VERSIONS.unwrap,
          params: { treeId, region },
          scopeRegions: region.map((p) => regionId(p.x, p.y)),
          scenario,
          rationale: {
            rule: "KEEP_ALL_LEGAL_INTEGER_CANDIDATES",
            evidence: { ambiguityId: payload.ambiguityId, count: candidates.length },
            accepted: false,
          },
        }).record;
        candidateSets.push({ objectId: candRec.objectId, version: candRec.version });
        refs.candidates.push({ objectId: candRec.objectId, version: candRec.version });
      }
      void regionListId;
    });
  });

  return { refs, trees: builtTrees, params };
}

type UnwrapInputsLike = Parameters<typeof buildUnwrapTree>[0];

function chooseRoots(
  w: number,
  pixels: { x: number; y: number }[],
  quality: Map<number, number>,
  max: number,
): { x: number; y: number }[] {
  const ranked = [...pixels].sort((a, b) => (quality.get(idx(w, b.x, b.y)) ?? 0) - (quality.get(idx(w, a.x, a.y)) ?? 0));
  const roots = ranked.length ? [ranked[0]] : pixels.slice(0, 1);
  // 质量最高 + 质量最低 + 首个像素，保证多树差异
  if (max >= 2 && ranked.length > 1) roots.push(ranked[ranked.length - 1]);
  if (max >= 3 && pixels.length > 2 && !roots.includes(pixels[0])) roots.push(pixels[0]);
  return roots.slice(0, max);
}
