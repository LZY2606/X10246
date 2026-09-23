import type {
  AlgorithmFingerprint,
  ArtifactKind,
  DerivedArtifact,
  RawKind,
  RawPayload,
  RawVersion,
  SourceRef
} from './types.js';
import { canonicalJSON, contentRef, shortDigest } from './identity.js';
import { toGrid } from './grid.js';
import { qualityMap, residueMap } from './quality.js';
import { connectedRegions } from './regions.js';
import { buildBranchCuts } from './branchcuts.js';
import { unwrapRegions } from './unwrap.js';
import { convertToHeight } from './height.js';
import { SeededRng } from './clock.js';
import type { BranchCutNetwork } from './branchcuts.js';
import type { RegionResult } from './regions.js';
import type { UnwrapResult } from './unwrap.js';

export const PIPELINE_VERSION = '1.0.0';

export interface PipelineParams {
  lowAmplitudeThreshold: number;
  maxLegalOffset: number;
  seed: number;
}

export const DEFAULT_PARAMS: PipelineParams = {
  lowAmplitudeThreshold: 0.2,
  maxLegalOffset: 1,
  seed: 20260923
};

/** Explicit snapshot of the raw versions one derivation run is based on. */
export type RawSnapshot = Partial<Record<RawKind, RawVersion>>;

export function fingerprint(
  algorithm: string,
  parameters: Record<string, unknown>
): AlgorithmFingerprint {
  const material = canonicalJSON({
    algorithm,
    algorithmVersion: PIPELINE_VERSION,
    parameters
  });
  return {
    algorithm,
    algorithmVersion: PIPELINE_VERSION,
    parameters,
    fingerprint: contentRef(material).sha256
  };
}

export function rawSource(version: RawVersion): SourceRef {
  return {
    kind: 'raw_version',
    id: `${version.lineage}@v${version.version}`,
    version: version.version,
    sha256: version.ref.sha256,
    summary: summaryOf(version.payload)
  };
}

export function summaryOf(payload: RawPayload): string {
  switch (payload.kind) {
    case 'wrapped_phase':
    case 'amplitude':
    case 'snr_score':
    case 'validity_mask':
      return `${payload.kind} ${payload.grid.rows}x${payload.grid.cols} ${payload.unit}`;
    case 'wavelength':
      return `wavelength ${payload.lambda.value}${payload.lambda.unit}`;
    case 'incidence_geometry':
      return `incidence ${payload.incidenceAngle.value}${payload.incidenceAngle.unit} ${payload.sensitivityModel}`;
    case 'calibration_surface':
      return `calibration plane (${payload.calibrationFrames.length} frames)`;
    case 'cut_edit_history':
      return `cut edits x${payload.edits.length}`;
  }
}

export interface PipelineStageResult {
  artifact: Omit<DerivedArtifact, 'id' | 'status' | 'stale' | 'supersededBy' | 'createdAt'>;
}

function artifact(
  kind: ArtifactKind,
  algo: AlgorithmFingerprint,
  sources: SourceRef[],
  payload: unknown
): PipelineStageResult {
  return {
    artifact: {
      kind,
      algorithm: algo,
      sources,
      ref: contentRef(payload),
      payload,
      diagnostic: undefined
    }
  };
}

/** Run the full deterministic chain for one explicit raw snapshot. */
export function runPipeline(
  snapshot: RawSnapshot,
  params: PipelineParams,
  chosenOffsets: Map<number, number>
): { artifacts: PipelineStageResult[]; network: BranchCutNetwork; regions: RegionResult; unwrap: UnwrapResult } {
  const required: RawKind[] = [
    'wrapped_phase',
    'amplitude',
    'snr_score',
    'validity_mask',
    'wavelength',
    'incidence_geometry',
    'calibration_surface',
    'cut_edit_history'
  ];
  for (const kind of required) {
    if (!snapshot[kind]) throw new Error(`pipeline snapshot missing ${kind}`);
  }
  const phasePayload = snapshot['wrapped_phase']!.payload;
  const amplitudePayload = snapshot['amplitude']!.payload;
  const snrPayload = snapshot['snr_score']!.payload;
  const validityPayload = snapshot['validity_mask']!.payload;
  if (
    phasePayload.kind !== 'wrapped_phase' ||
    amplitudePayload.kind !== 'amplitude' ||
    snrPayload.kind !== 'snr_score' ||
    validityPayload.kind !== 'validity_mask'
  ) {
    throw new Error('pipeline snapshot kind mismatch');
  }

  const phase = toGrid(phasePayload);
  const amplitude = toGrid(amplitudePayload);
  const snr = toGrid(snrPayload);
  const validity = toGrid(validityPayload);
  const allRawSources = required.map((kind) => rawSource(snapshot[kind]!));
  const rng = new SeededRng(params.seed);

  const qAlgo = fingerprint('quality_map', {
    lowAmplitudeThreshold: params.lowAmplitudeThreshold
  });
  const quality = qualityMap(phase, amplitude, snr, validity, {
    lowAmplitudeThreshold: params.lowAmplitudeThreshold
  });
  const qualityPayloadOut = {
    quality: Array.from(quality.quality),
    lowAmplitude: Array.from(quality.lowAmplitude).map((v) => v === 1),
    unknownPolicy: 'LOW_AMPLITUDE_PIXELS_KEEP_NO_PHASE'
  };
  const qualityStage = artifact('quality_map', qAlgo, allRawSources, qualityPayloadOut);

  const rAlgo = fingerprint('residue_map', { seed: params.seed });
  const residues = residueMap(phase, quality.lowAmplitude);
  const residueStage = artifact(
    'residue_map',
    rAlgo,
    [rawSource(snapshot['wrapped_phase']!), ...qualityStage.artifact.sources.slice(0, 1)],
    {
      charge: Array.from(residues.charge),
      unknownLoops: Array.from(residues.unknownLoops).map((v) => v === 1)
    }
  );

  const regionAlgo = fingerprint('connected_regions', {});
  const regions = connectedRegions(phase, quality.lowAmplitude);
  const regionStage = artifact(
    'connected_regions',
    regionAlgo,
    [rawSource(snapshot['wrapped_phase']!)],
    {
      regionOf: Array.from(regions.regionOf),
      regionCount: regions.regionCount,
      sizes: regions.sizes,
      multiConnected: regions.multiConnected
    }
  );

  const cutAlgo = fingerprint('branch_cut_network', { seed: params.seed });
  const editPayload = snapshot['cut_edit_history']!.payload;
  const edits = editPayload.kind === 'cut_edit_history' ? editPayload.edits : [];
  const network = buildBranchCuts(phase, residues.charge, residues.unknownLoops, edits, rng);
  const cutStage = artifact(
    'branch_cut_network',
    cutAlgo,
    [
      rawSource(snapshot['wrapped_phase']!),
      rawSource(snapshot['cut_edit_history']!)
    ],
    {
      edges: network.edges.map((edge) => ({
        id: edge.id,
        from: [edge.r1, edge.c1],
        to: [edge.r2, edge.c2],
        offsetCycles: edge.offsetCycles,
        legalOffsets: edge.legalOffsets,
        source: edge.source
      })),
      unpairedResidues: network.unpairedResidues
    }
  );

  const unwrapAlgo = fingerprint('unwrapped_phase', {
    seed: params.seed,
    maxLegalOffset: params.maxLegalOffset
  });
  const unwrap = unwrapRegions(
    phase,
    quality.quality,
    regions,
    network,
    residues.charge,
    { maxLegalOffset: params.maxLegalOffset }
  );
  const unwrapStage = artifact(
    'unwrapped_phase',
    unwrapAlgo,
    [
      rawSource(snapshot['wrapped_phase']!),
      { ...cutStage.artifact.sources[0]!, summary: 'branch_cut_network' }
    ],
    serializeUnwrap(unwrap)
  );

  const cycleAlgo = fingerprint('cycle_residual', {});
  const cycleStage = artifact(
    'cycle_residual',
    cycleAlgo,
    [
      rawSource(snapshot['wrapped_phase']!),
      { ...cutStage.artifact.sources[0]!, summary: 'branch_cut_network' }
    ],
    {
      regions: unwrap.regions.map((region) => ({
        regionId: region.regionId,
        loops: region.cycles,
        maxFraction: region.maxFraction
      })),
      hasNonClosingCycle: unwrap.hasNonClosingCycle
    }
  );

  const wavelength = snapshot['wavelength']!.payload;
  const geometry = snapshot['incidence_geometry']!.payload;
  const calibration = snapshot['calibration_surface']!.payload;
  if (
    wavelength.kind !== 'wavelength' ||
    geometry.kind !== 'incidence_geometry' ||
    calibration.kind !== 'calibration_surface'
  ) {
    throw new Error('pipeline scalar snapshot kind mismatch');
  }
  const heightAlgo = fingerprint('height_surface', {
    sensitivityModel: geometry.sensitivityModel
  });
  const height = convertToHeight(
    unwrap,
    phase.cols,
    wavelength,
    geometry,
    calibration,
    chosenOffsets
  );
  const heightStage = artifact(
    'height_surface',
    heightAlgo,
    [
      rawSource(snapshot['wavelength']!),
      rawSource(snapshot['incidence_geometry']!),
      rawSource(snapshot['calibration_surface']!),
      {
        kind: 'artifact',
        id: 'unwrapped_phase(previous)',
        sha256: unwrapStage.artifact.ref.sha256,
        summary: 'unwrapped_phase'
      }
    ],
    serializeHeight(height)
  );

  void shortDigest;
  return {
    artifacts: [
      qualityStage,
      residueStage,
      regionStage,
      cutStage,
      unwrapStage,
      cycleStage,
      heightStage
    ],
    network,
    regions,
    unwrap
  };
}

function serializeUnwrap(unwrap: UnwrapResult) {
  return {
    regions: unwrap.regions.map((region) => ({
      regionId: region.regionId,
      root: region.root,
      treePath: region.treePath,
      pathDetail: region.pathDetail,
      edgeCycles: region.edgeCycles,
      unwrapped: [...region.unwrapped.entries()].map(([pixel, phi]) => ({ pixel, phi }))
    })),
    regionOffsets: unwrap.regionOffsets,
    ambiguousCuts: unwrap.ambiguousCuts.map((edge) => ({
      id: edge.id,
      legalOffsets: edge.legalOffsets
    })),
    hasNonClosingCycle: unwrap.hasNonClosingCycle
  };
}

function serializeHeight(height: ReturnType<typeof convertToHeight>) {
  return {
    heights: height.heights.map((entry) => ({
      regionId: entry.regionId,
      values: [...entry.values.entries()].map(([pixel, z]) => ({ pixel, zMetres: z }))
    })),
    unknown: height.unknown,
    diagnostics: height.diagnostics,
    chain: height.chain
  };
}
