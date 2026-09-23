import {
  buildQualityMap,
  DEFAULT_QUALITY_PARAMS,
  QUALITY_ALGO_VERSION,
} from '../algo/quality';
import { buildResidueMap, RESIDUE_ALGO_VERSION } from '../algo/residues';
import { buildCutNetwork, CUT_ALGO_VERSION, DEFAULT_CUT_PARAMS } from '../algo/cuts';
import {
  buildUnwrapTrees,
  DEFAULT_UNWRAP_PARAMS,
  UNWRAP_ALGO_VERSION,
} from '../algo/unwraptree';
import { buildCycleResiduals, CYCLE_ALGO_VERSION } from '../algo/cycles';
import {
  CANDIDATE_ALGO_VERSION,
  DEFAULT_CANDIDATE_PARAMS,
  enumerateCandidates,
} from '../algo/candidates';
import { buildHeightField, HEIGHT_ALGO_VERSION } from '../algo/height';
import type {
  CalibrationPlane,
  CutEditHistory,
  EntityEnvelope,
  IlluminationGeometry,
  InvalidMaskFrame,
  SignalQualityFrame,
  WavelengthSpec,
  WrappedPhaseFrame,
} from './types';

export interface RawContext {
  wrappedPhase: WrappedPhaseFrame;
  signalQuality: SignalQualityFrame;
  invalidMask: InvalidMaskFrame;
  wavelength: WavelengthSpec;
  geometry: IlluminationGeometry;
  calibration: CalibrationPlane;
  cutHistory: CutEditHistory;
}

/**
 * 一次完整派生流水线。每一步都报告算法版本、参数指纹与直接来源，
 * 供账本层构造内容寻址的派生实体。
 */
export function runPipeline(raw: RawContext, seed = 20260924) {
  const qualityParams = { ...DEFAULT_QUALITY_PARAMS };
  const cutParams = { ...DEFAULT_CUT_PARAMS, seed };
  const unwrapParams = { ...DEFAULT_UNWRAP_PARAMS, seed };
  const candidateParams = { ...DEFAULT_CANDIDATE_PARAMS };

  const quality = buildQualityMap(raw.wrappedPhase.grid, raw.signalQuality, raw.invalidMask, qualityParams);
  const residues = buildResidueMap(raw.wrappedPhase, raw.invalidMask);
  const cuts = buildCutNetwork(raw.wrappedPhase.grid, residues, raw.invalidMask, raw.cutHistory, cutParams);
  const trees = buildUnwrapTrees(raw.wrappedPhase, raw.invalidMask, quality, cuts, unwrapParams);
  const cycles = buildCycleResiduals(raw.wrappedPhase, raw.invalidMask, residues, cuts, trees);
  const candidateSet = enumerateCandidates(raw.wrappedPhase, cuts, trees, raw.calibration, candidateParams);

  return {
    steps: [
      {
        kind: 'quality_map' as const,
        algoVersion: QUALITY_ALGO_VERSION,
        params: qualityParams,
        data: quality,
      },
      {
        kind: 'residue_map' as const,
        algoVersion: RESIDUE_ALGO_VERSION,
        params: { convention: 'Itoh plaquette 2pi wrap' },
        data: residues,
      },
      {
        kind: 'cut_network' as const,
        algoVersion: CUT_ALGO_VERSION,
        params: cutParams,
        data: cuts,
      },
      ...trees.map((tree) => ({
        kind: 'unwrap_tree' as const,
        algoVersion: UNWRAP_ALGO_VERSION,
        params: unwrapParams,
        data: tree,
      })),
      {
        kind: 'cycle_residual' as const,
        algoVersion: CYCLE_ALGO_VERSION,
        params: { includeNonTreeEdges: true },
        data: cycles,
      },
      {
        kind: 'integer_candidate_set' as const,
        algoVersion: CANDIDATE_ALGO_VERSION,
        params: candidateParams,
        data: candidateSet,
      },
    ],
    /** 对单个候选产生高度转换链（高度依赖被选中的整周解）。 */
    heightFor(candidateIndex: number) {
      const candidate = candidateSet.candidates[candidateIndex];
      if (!candidate) return null;
      return {
        kind: 'height_field' as const,
        algoVersion: HEIGHT_ALGO_VERSION,
        params: { coordinateUnit: 'm' },
        data: buildHeightField(
          raw.wrappedPhase,
          raw.wavelength,
          raw.geometry,
          raw.calibration,
          candidate
        ),
      };
    },
  };
}

export type PipelineStep = ReturnType<typeof runPipeline>['steps'][number];

export type RawEnvelopeMap = {
  [K in keyof RawContext]: EntityEnvelope<RawContext[K]>;
};
