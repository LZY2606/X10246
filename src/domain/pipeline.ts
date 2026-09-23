import type {
  InterferogramBundle, WavelengthSpec, IlluminationGeometry, CalibrationPlane,
} from './types';
import { canonicalize, digestOf } from './hash';
import { computeQuality } from './engine-quality';
import { detectResidues } from './engine-residue';
import { buildCutNetwork } from './engine-cuts';
import { buildRegionForest } from './engine-tree';
import { evaluateCycles } from './engine-cycle';
import { unwrapSurface } from './engine-cycle';
import { buildHeightChain } from './engine-height';
import type { VersionRef } from './types';

export const ALGORITHM_VERSION = {
  quality: 'quality:snr-second-diff@1.0.0',
  residue: 'residue:plaquette-loop@1.0.0',
  cuts: 'branchcut:goldstein-greedy@1.0.0',
  tree: 'unwrap:quality-prim@1.0.0',
  cycle: 'cycle:tree-chord@1.0.0',
  height: 'height:calibration-plane@1.0.0',
};

export interface PipelineParams {
  lowSnrThreshold: number;
  maxIntegerK: number;
}

export const DEFAULT_PARAMS: PipelineParams = { lowSnrThreshold: 5, maxIntegerK: 6 };

/** 派生层一次完整重放的纯函数结果（不碰数据库） */
export function runPipeline(bundle: InterferogramBundle, params: PipelineParams = DEFAULT_PARAMS) {
  const pf = digestOf(canonicalize(params));
  const quality = computeQuality(bundle.wrappedPhase, bundle.snr, bundle.mask, params.lowSnrThreshold);
  const residues = detectResidues(bundle.wrappedPhase, bundle.mask);
  const cuts = buildCutNetwork(bundle.wrappedPhase, residues, bundle.cutHistory);
  const forest = buildRegionForest(bundle.wrappedPhase, bundle.mask, quality, cuts);
  const cycleReport = evaluateCycles(bundle.wrappedPhase, bundle.mask, forest, params.maxIntegerK);
  const surface = unwrapSurface(bundle.wrappedPhase, bundle.mask, forest);
  return { quality, residues, cuts, forest, cycleReport, surface, parameterFingerprint: pf };
}

export interface HeightInputs {
  wavelength: WavelengthSpec;
  geometry: IlluminationGeometry;
  calibration: CalibrationPlane;
  unwrappedRef: VersionRef;
  wavelengthRef: VersionRef;
  geometryRef: VersionRef;
  calibrationRef: VersionRef;
  parameterFingerprint: string;
}

export function runHeightChain(bundle: InterferogramBundle, unwrappedGrid: Parameters<typeof buildHeightChain>[0], inputs: HeightInputs) {
  return buildHeightChain(unwrappedGrid, inputs.wavelength, inputs.geometry, inputs.calibration, {
    algorithmVersion: ALGORITHM_VERSION.height,
    parameterFingerprint: inputs.parameterFingerprint,
    unwrappedRef: inputs.unwrappedRef,
    wavelengthRef: inputs.wavelengthRef,
    geometryRef: inputs.geometryRef,
    calibrationRef: inputs.calibrationRef,
  });
}
