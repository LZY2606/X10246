/**
 * 派生流水线：每个派生结果都带算法版本、参数指纹与直接来源事件。
 * 顺序：quality -> residues -> regions -> cuts -> unwrap(多树) -> integers -> height。
 * 局部输入变化只使依赖它的结果过期（通过 refs + 版本自然表达）。
 */
import type { Ledger } from '../db/ledger.ts';
import { VirtualClock } from '../domain/rng.ts';
import { loadFrames } from './readers.ts';
import { rasterToTiles } from '../domain/frames.ts';
import {
  ALGO_VERSION,
  DEFAULT_PARAMS,
  parameterFingerprint,
  computeQualityMap,
  computeResidues,
  computeRegions,
  pairResidues,
  growUnwrapTree,
  enumerateIntegerCandidates,
  QualityFlag,
  type AlgoParams,
} from '../domain/unwrap.ts';
import { continuePipeline } from './pipeline-tail.ts';
import type {
  QualityMapContent,
  ResidueMapContent,
  RegionMapContent,
  CutNetworkContent,
  Diagnostic,
} from '../domain/types.ts';

export interface SourceIds {
  phase: string;
  amplitude: string;
  snr: string;
  mask: string;
  wavelength: string;
  geometry: string;
  calibration: string;
  cutHistory: string;
}

export interface PipelineResult {
  quality: string;
  residues: string;
  regions: string;
  cuts: string;
  unwrap: string[]; // 多棵树
  integers: string[];
  height: string[];
  diagnostics: Diagnostic[];
}

export function runPipeline(
  ledger: Ledger,
  projectId: string,
  clock: VirtualClock,
  src: SourceIds,
  params: AlgoParams = DEFAULT_PARAMS,
): PipelineResult {
  const frames = loadFrames(ledger, {
    phase: src.phase,
    amplitude: src.amplitude,
    snr: src.snr,
    mask: src.mask,
  });
  const pf = parameterFingerprint(params);
  const diagnostics: Diagnostic[] = [];

  // --- quality ---
  const q = computeQualityMap(frames.amplitude, frames.snr, frames.mask, params);
  const scoreTiles = rasterToTiles(Array.from(q.score), frames.rows, frames.cols);
  const scoreTileIds = scoreTiles.map((t) => ledger.putTile(t));
  const flagLabels: QualityMapContent['flags'] = [];
  for (let i = 0; i < frames.rows * frames.cols; i++) {
    const f = q.flags[i];
    if (f === QualityFlag.OK) flagLabels.push('OK');
    else {
      if (f & QualityFlag.MASKED) flagLabels.push('MASKED');
      else if (f & QualityFlag.LOW_AMPLITUDE) flagLabels.push('LOW_AMPLITUDE');
      else if (f & QualityFlag.LOW_SNR) flagLabels.push('LOW_SNR');
      else flagLabels.push('UNKNOWN');
    }
  }
  const flagsTiles = rasterToTiles(
    Array.from(q.flags).map((x) => x as number),
    frames.rows,
    frames.cols,
  );
  const flagsTileIds = flagsTiles.map((t) => ledger.putTile(t));
  const qPayload: QualityMapContent = {
    algorithmVersion: ALGO_VERSION,
    parameterFingerprint: pf,
    derivesFrom: {
      amplitudeContentId: ledger.getEvent(src.amplitude)!.contentId,
      qualityScoreContentId: ledger.getEvent(src.snr)!.contentId,
      maskContentId: ledger.getEvent(src.mask)!.contentId,
      threshold: params.amplitudeThreshold,
    },
    scoreContentId: 'frame:' + scoreTileIds.join(','),
    flags: flagLabels,
    flagsContentId: 'frame:' + flagsTileIds.join(','),
    diagnostics: [],
  };
  const qEv = ledger.append(
    projectId,
    {
      type: 'quality.computed',
      entity: { type: 'qualityMap', key: 'main' },
      payload: qPayload,
      refs: [src.amplitude, src.snr, src.mask],
      actor: 'algorithm',
    },
    () => clock.now(),
  );

  // --- residues ---
  const valid = new Uint8Array(frames.rows * frames.cols);
  for (let i = 0; i < valid.length; i++) {
    valid[i] =
      frames.mask[i] && !(q.flags[i] & QualityFlag.LOW_AMPLITUDE) && Number.isFinite(frames.phase[i])
        ? 1
        : 0;
  }
  const residues = computeResidues(frames.phase, valid, frames.rows, frames.cols);
  if (residues.length) {
    diagnostics.push({
      code: 'RESIDUES_PRESENT',
      severity: 'warning',
      message: `检测到 ${residues.length} 个残差点，需要支路切口隔挡`,
    });
  }
  const rPayload: ResidueMapContent = {
    algorithmVersion: ALGO_VERSION,
    parameterFingerprint: pf,
    derivesFrom: {
      phaseContentId: ledger.getEvent(src.phase)!.contentId,
      maskContentId: ledger.getEvent(src.mask)!.contentId,
    },
    residues: residues.map((x, i) => ({
      r: x.r,
      c: x.c,
      charge: x.charge,
      windingTurns: x.windingTurns,
    })),
    diagnostics: residues.length
      ? [
          {
            code: 'RESIDUES_PRESENT',
            severity: 'warning',
            message: `${residues.length} residues`,
          },
        ]
      : [],
  };
  const rEv = ledger.append(
    projectId,
    {
      type: 'residues.computed',
      entity: { type: 'residueMap', key: 'main' },
      payload: rPayload,
      refs: [src.phase, src.mask],
      actor: 'algorithm',
    },
    () => clock.now(),
  );

  // --- regions ---
  const regionResult = computeRegions(frames.mask, q.flags, frames.rows, frames.cols);
  const labelRas = new Float64Array(regionResult.labels.length).fill(NaN);
  for (let i = 0; i < labelRas.length; i++) if (regionResult.labels[i] !== -1) labelRas[i] = regionResult.labels[i];
  const labelTileIds = rasterToTiles(Array.from(labelRas), frames.rows, frames.cols).map((t) =>
    ledger.putTile(t),
  );
  const regPayload: RegionMapContent = {
    algorithmVersion: ALGO_VERSION,
    parameterFingerprint: pf,
    derivesFrom: {
      maskContentId: ledger.getEvent(src.mask)!.contentId,
      qualityMapContentId: qEv.contentId,
    },
    regions: regionResult.regions.map((reg) => ({
      regionId: reg.regionId,
      pixels: reg.pixels,
      containsHole: reg.containsHole,
      holes: reg.holes,
    })),
    labelContentId: 'frame:' + labelTileIds.join(','),
    diagnostics: regionResult.regions.some((r) => r.containsHole)
      ? [{ code: 'MULTIPLY_CONNECTED', severity: 'warning', message: '存在孔洞（多连通区域）' }]
      : [],
  };
  const regEv = ledger.append(
    projectId,
    {
      type: 'regions.computed',
      entity: { type: 'regionMap', key: 'main' },
      payload: regPayload,
      refs: [src.mask, qEv.eventId],
      actor: 'algorithm',
    },
    () => clock.now(),
  );

  return continuePipeline(ledger, projectId, clock, src, params, {
    frames,
    q,
    valid,
    residues,
    regionResult,
    qualityEventId: qEv.eventId,
    residueEventId: rEv.eventId,
    regionEventId: regEv.eventId,
    diagnostics,
  });
}
