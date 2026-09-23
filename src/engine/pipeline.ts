import type {
  CalibrationSurface,
  CutEditHistory,
  DerivedEntity,
  IlluminationGeometry,
  InvalidMask,
  QualityScoreMap,
  Wavelength,
  WrappedPhaseFrame,
} from '../domain/types.js';
import {
  computeBranchCuts,
  computeCycleResiduals,
  computeHeight,
  computeIntegerCandidates,
  computeResidues,
  computeSolution,
  computeUnwrapTrees,
  type AcceptedIntegers,
  type EngineInputs,
  type UnwrapParams,
} from './unwrap.js';
import type { AmplitudeFrame, BranchCutNetwork } from '../domain/types.js';

export interface PipelineRaw {
  wrapped: WrappedPhaseFrame;
  amplitude: AmplitudeFrame;
  quality: QualityScoreMap;
  invalid: InvalidMask;
  wavelength: Wavelength;
  geometry: IlluminationGeometry;
  calibration: CalibrationSurface;
  cutHistory: CutEditHistory[];
}

export interface PipelineResult {
  residues: DerivedEntity;
  cuts: BranchCutNetwork;
  trees: DerivedEntity[];
  cycles: DerivedEntity;
  candidates: DerivedEntity;
  solution: DerivedEntity;
  height: DerivedEntity;
  all: DerivedEntity[];
}

/**
 * 从一组被引用版本的原始输入逐步重放相位展开与标定链。
 * 每个产物的 sources 都是其「直接来源」的精确版本引用，
 * 局部输入变化只会使依赖它的产物在 store 层过期。
 */
export function runPipeline(
  raw: PipelineRaw,
  params: UnwrapParams,
  accepted: AcceptedIntegers,
  createdAt: string,
): PipelineResult {
  const engineInputs: EngineInputs = {
    wrapped: raw.wrapped,
    amplitude: raw.amplitude,
    quality: raw.quality,
    invalid: raw.invalid,
    cutHistory: raw.cutHistory.map((h) => ({ added: h.added, removed: h.removed })),
    params,
  };

  const residues = computeResidues(engineInputs, createdAt);
  const cuts = computeBranchCuts(engineInputs, residues, createdAt);
  const trees = computeUnwrapTrees(engineInputs, cuts, createdAt);
  const cycles = computeCycleResiduals(engineInputs, cuts, trees, createdAt);
  const candidates = computeIntegerCandidates(engineInputs, cuts, trees, cycles, createdAt);
  const solution = computeSolution(engineInputs, cuts, trees, cycles, candidates, accepted, createdAt);
  const height = computeHeight(
    engineInputs,
    raw.wavelength,
    raw.geometry,
    raw.calibration,
    solution,
    createdAt,
  );

  const all: DerivedEntity[] = [
    residues,
    cuts,
    ...trees,
    cycles,
    candidates,
    solution,
    height,
  ];

  return { residues, cuts, trees, cycles, candidates, solution, height, all };
}
