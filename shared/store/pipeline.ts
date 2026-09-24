import type { ProjectStore } from './project-store.js';
import type {
  AmplitudeInput,
  BranchCutNetworkPayload,
  CalibrationPlaneInput,
  HeightChainPayload,
  IlluminationGeometryInput,
  InvalidMaskInput,
  QualityMapPayload,
  ResidueMapPayload,
  SourceRef,
  UnwrappedForestPayload,
  WavelengthInput,
  WrappedPhaseInput
} from '../domain/types.js';
import { computeQualityMap, DEFAULT_QUALITY_PARAMS, QualityParams } from '../domain/quality.js';
import {
  computeResidueMap,
  computeBranchCuts,
  DEFAULT_RESIDUE_PARAMS,
  DEFAULT_CUT_PARAMS,
  ResidueParams,
  CutParams
} from '../domain/residues.js';
import { computeUnwrappedForest, DEFAULT_UNWRAP_PARAMS, UnwrapParams } from '../domain/unwrap.js';
import { computeHeightChain, DEFAULT_HEIGHT_PARAMS, HeightParams } from '../domain/height.js';

export interface PipelineParams {
  quality: QualityParams;
  residue: ResidueParams;
  cut: CutParams;
  unwrap: UnwrapParams;
  height: HeightParams;
}
export const DEFAULT_PIPELINE_PARAMS: PipelineParams = {
  quality: DEFAULT_QUALITY_PARAMS,
  residue: DEFAULT_RESIDUE_PARAMS,
  cut: DEFAULT_CUT_PARAMS,
  unwrap: DEFAULT_UNWRAP_PARAMS,
  height: DEFAULT_HEIGHT_PARAMS
};

export interface PipelineInputs {
  wrappedPhase: WrappedPhaseInput;
  amplitude: AmplitudeInput;
  invalidMask: InvalidMaskInput;
  wavelength: WavelengthInput;
  geometry: IlluminationGeometryInput;
  calibration: CalibrationPlaneInput;
}

export interface PipelineResult {
  quality: QualityMapPayload;
  residues: ResidueMapPayload;
  cuts: BranchCutNetworkPayload;
  forest: UnwrappedForestPayload;
  heights: HeightChainPayload;
  ids: {
    quality: string;
    residues: string;
    cuts: string;
    forest: string;
    heights: string;
  };
}

function ref(store: ProjectStore, id: string, role: string): SourceRef {
  const e = store.getEntity(id) as { version: number; contentHash: string };
  return { entityId: id, version: e.version, contentHash: e.contentHash, role };
}

/**
 * 端到端派生流水线。每个派生值都带算法版本、参数指纹、直接来源；
 * 并把“不猜相位 / 切口整周显式 / 多树与环残差 / 多解候选”写入机器可读判断。
 */
export function runPipeline(
  store: ProjectStore,
  inputs: PipelineInputs,
  params: PipelineParams = DEFAULT_PIPELINE_PARAMS,
  scenario?: string
): PipelineResult {
  const ids = {
    phase: 'input:wrapped_phase',
    amplitude: 'input:amplitude',
    mask: 'input:invalid_mask',
    wavelength: 'input:wavelength',
    geometry: 'input:illumination_geometry',
    calibration: 'input:calibration_plane'
  };

  const quality = computeQualityMap(inputs.wrappedPhase, inputs.amplitude, inputs.invalidMask, params.quality);
  const q = store.computeDerived('quality_map', quality, [
    ref(store, ids.phase, 'wrapped_phase'),
    ref(store, ids.amplitude, 'amplitude'),
    ref(store, ids.mask, 'invalid_mask')
  ]);
  judgeLowAmplitude(store, quality, inputs, scenario);

  const residues = computeResidueMap(inputs.wrappedPhase, quality, params.residue);
  const r = store.computeDerived('residue_map', residues, [
    ref(store, ids.phase, 'wrapped_phase'),
    { entityId: q.entity.id, version: q.entity.version, contentHash: q.entity.contentHash, role: 'quality_map' }
  ]);

  const cuts = computeBranchCuts(residues, params.cut);
  const c = store.computeDerived('branch_cut_network', cuts, [
    { entityId: r.entity.id, version: r.entity.version, contentHash: r.entity.contentHash, role: 'residue_map' }
  ]);
  judgeCuts(store, cuts, scenario);

  const forest = computeUnwrappedForest(inputs.wrappedPhase, quality, residues, cuts, params.unwrap);
  const f = store.computeDerived('unwrapped_forest', forest, [
    ref(store, ids.phase, 'wrapped_phase'),
    { entityId: q.entity.id, version: q.entity.version, contentHash: q.entity.contentHash, role: 'quality_map' },
    { entityId: c.entity.id, version: c.entity.version, contentHash: c.entity.contentHash, role: 'branch_cut_network' },
    { entityId: r.entity.id, version: r.entity.version, contentHash: r.entity.contentHash, role: 'residue_map' }
  ]);
  judgeForest(store, forest, scenario);

  const heights = computeHeightChain(
    forest,
    inputs.wavelength,
    inputs.geometry,
    inputs.calibration,
    params.height
  );
  const h = store.computeDerived('height_chain', heights, [
    { entityId: f.entity.id, version: f.entity.version, contentHash: f.entity.contentHash, role: 'unwrapped_forest' },
    ref(store, ids.wavelength, 'wavelength'),
    ref(store, ids.geometry, 'illumination_geometry'),
    ref(store, ids.calibration, 'calibration_plane')
  ]);

  return {
    quality,
    residues,
    cuts,
    forest,
    heights,
    ids: {
      quality: q.entity.id,
      residues: r.entity.id,
      cuts: c.entity.id,
      forest: f.entity.id,
      heights: h.entity.id
    }
  };
}

function judgeLowAmplitude(
  store: ProjectStore,
  quality: QualityMapPayload,
  inputs: PipelineInputs,
  scenario?: string
): void {
  const holes: number[] = [];
  quality.lowAmplitudeHole.forEach((flag, i) => {
    if (flag) holes.push(i);
  });
  store.recordJudgment({
    scenario,
    subject: 'quality_map:low_amplitude',
    rule: 'low_amplitude_must_not_guess_phase',
    outcome: holes.length > 0 ? 'flagged' : 'adopted',
    evidence: {
      holePixels: holes.slice(0, 64),
      holeCount: holes.length,
      threshold: quality.threshold,
      maskedUnknown: quality.unknownReason.filter((x) => x === 'invalid_mask').length,
      assert: '低振幅孔洞 score=null，不参与展开，禁止猜相位'
    },
    refs: []
  });
}

function judgeCuts(store: ProjectStore, cuts: BranchCutNetworkPayload, scenario?: string): void {
  const unresolved = cuts.edges.filter((e) => e.integerOffset === null).length;
  store.recordJudgment({
    scenario,
    subject: 'branch_cut_network',
    rule: 'integer_offsets_across_cuts_must_be_explicit',
    outcome: unresolved > 0 ? 'flagged' : 'adopted',
    evidence: {
      cutCount: cuts.edges.length,
      unresolvedOffsetCount: unresolved,
      unpairedResidues: cuts.unpairedResidues.length,
      assert: '切口两侧整周偏移显式存储；未由人工确认者为 null，系统不猜'
    },
    refs: []
  });
}

function judgeForest(store: ProjectStore, forest: UnwrappedForestPayload, scenario?: string): void {
  const openCycles = forest.cycles.filter((c) => !c.closed);
  const ambiguousEdges = Object.entries(forest.integerCandidates).filter(([, cs]) =>
    cs.some((c) => !c.accepted && c.rejectReason?.startsWith('alt_integer_wrap'))
  );
  store.recordJudgment({
    scenario,
    subject: 'unwrapped_forest:trees',
    rule: 'multiple_trees_are_locally_consistent_keep_paths_and_cycle_residuals',
    outcome: forest.trees.length > 1 || openCycles.length > 0 ? 'flagged' : 'adopted',
    evidence: {
      treeCount: forest.trees.length,
      componentIds: forest.trees.map((t) => t.componentId),
      openCycleCount: openCycles.length,
      openCycles: openCycles.map((c) => ({
        id: c.id,
        integerResidual: c.integerResidual,
        enclosed: c.enclosedResidues.map((r) => `${r.u},${r.v}:${r.charge}`)
      })),
      assert: '不同展开树是局部一致解；保留树路径与环残差'
    },
    refs: []
  });
  store.recordJudgment({
    scenario,
    subject: 'unwrapped_forest:integer_candidates',
    rule: 'keep_all_legal_integer_candidates_when_not_unique',
    outcome: ambiguousEdges.length > 0 ? 'flagged' : 'adopted',
    evidence: {
      ambiguousEdgeCount: ambiguousEdges.length,
      edges: ambiguousEdges.slice(0, 16).map(([edge, cs]) => ({
        edge,
        candidates: cs.map((c) => ({ k: c.k, accepted: c.accepted, rejectReason: c.rejectReason }))
      })),
      assert: '无法唯一决定时保留全部合法候选及拒绝原因'
    },
    refs: []
  });
}
