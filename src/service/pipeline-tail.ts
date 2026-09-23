/**
 * 流水线后半段：支路切口 -> 多展开树 -> 整周候选 -> 高度链。
 * 保留：被采纳与未采纳的候选、多棵树的路径与循环残差。
 */
import type { Ledger } from '../db/ledger.ts';
import { VirtualClock } from '../domain/rng.ts';
import { rasterToTiles } from '../domain/frames.ts';
import {
  ALGO_VERSION,
  parameterFingerprint,
  pairResidues,
  growUnwrapTree,
  enumerateIntegerCandidates,
  type AlgoParams,
} from '../domain/unwrap.ts';
import { buildHeightChain, sensitivityNormal, HEIGHT_ALGO_VERSION } from '../domain/height.ts';
import type { LoadedFrames } from './readers.ts';
import type {
  CutNetworkContent,
  UnwrapTreeContent,
  IntegerCandidatesContent,
  HeightChainContent,
} from '../domain/types.ts';
import type { SourceIds, PipelineResult } from './pipeline.ts';

export interface PipelineContext {
  frames: LoadedFrames;
  q: ReturnType<typeof import('../domain/unwrap.ts').computeQualityMap>;
  valid: Uint8Array;
  residues: ReturnType<typeof import('../domain/unwrap.ts').computeResidues>;
  regionResult: ReturnType<typeof import('../domain/unwrap.ts').computeRegions>;
  qualityEventId: string;
  residueEventId: string;
  regionEventId: string;
  diagnostics: import('../domain/types.ts').Diagnostic[];
}

export function continuePipeline(
  ledger: Ledger,
  projectId: string,
  clock: VirtualClock,
  src: SourceIds,
  params: AlgoParams,
  ctx: PipelineContext,
): PipelineResult {
  const { frames, regionResult, residueEventId, regionEventId } = ctx;
  const pf = parameterFingerprint(params);

  // --- cuts：残差配对 + 人工切口历史 ---
  const algoCuts = pairResidues(ctx.residues, frames.rows, frames.cols);
  const hist = ledger.getEvent(src.cutHistory)?.payload as {
    edits: Array<{ action: string; a: { r: number; c: number }; b: { r: number; c: number } }>;
  };
  const humanCuts = (hist?.edits ?? [])
    .filter((e) => e.action === 'add-cut' || e.action === 'place')
    .map((e, i) => ({
      cutId: 'cut:human:' + i,
      a: e.a,
      b: e.b,
      integerOffsetTurns: null,
      kind: 'human' as const,
      residues: [] as string[],
    }));
  const cuts = [...algoCuts, ...humanCuts];
  const cutPayload: CutNetworkContent = {
    algorithmVersion: ALGO_VERSION,
    parameterFingerprint: pf,
    derivesFrom: {
      residueMapEventId: residueEventId,
      regionMapEventId: regionEventId,
      cutHistoryEventId: src.cutHistory,
    },
    cuts: cuts.map((c) => ({
      cutId: c.cutId,
      a: c.a,
      b: c.b,
      integerOffsetTurns: c.integerOffsetTurns,
      kind: c.kind,
      residues: c.residues,
    })),
    diagnostics: cuts.length
      ? [{ code: 'BRANCH_CUTS_PLACED', severity: 'info', message: `${cuts.length} 条支路切口` }]
      : [],
  };
  const cutEv = ledger.append(
    projectId,
    {
      type: 'cuts.computed',
      entity: { type: 'cutNetwork', key: 'main' },
      payload: cutPayload,
      refs: [residueEventId, regionEventId, src.cutHistory],
      actor: 'algorithm',
    },
    () => clock.now(),
  );

  // --- unwrap：每个连通区域 × 两种树（质量引导 / BFS），保留全部路径与循环残差 ---
  const unwrapEventIds: string[] = [];
  const integerEventIds: string[] = [];
  const heightEventIds: string[] = [];
  const variants = ['mst-quality', 'bfs-border'] as const;

  for (let ri = 0; ri < regionResult.regions.length; ri++) {
    const region = regionResult.regions[ri];
    for (const variant of variants) {
      const tree = growUnwrapTree({
        variant,
        region,
        labels: regionResult.labels,
        phase: frames.phase,
        quality: ctx.q.score,
        cuts,
        rows: frames.rows,
        cols: frames.cols,
        params,
      });
      const unwrappedTileIds = rasterToTiles(Array.from(tree.unwrapped), frames.rows, frames.cols).map(
        (t) => ledger.putTile(t),
      );
      const openCycles = tree.cycles.filter((c) => !c.closed);
      const payload: UnwrapTreeContent = {
        algorithmVersion: ALGO_VERSION,
        parameterFingerprint: pf,
        treeVariant: variant,
        derivesFrom: {
          phaseContentId: ledger.getEvent(src.phase)!.contentId,
          cutNetworkEventId: cutEv.eventId,
          regionMapEventId: regionEventId,
        },
        edges: tree.edges,
        root: tree.root,
        regionId: region.regionId,
        cycleResiduals: tree.cycles.map((c) => ({
          cycleId: c.cycleId,
          vertices: c.vertices,
          residualTurns: c.residualTurns,
          closed: c.closed,
        })),
        unwrappedContentId: 'frame:' + unwrappedTileIds.join(','),
        diagnostics: openCycles.length
          ? [
              {
                code: 'CYCLE_NOT_CLOSED',
                severity: 'warning',
                message: `${variant}/${region.regionId}: ${openCycles.length} 个循环不闭合`,
              },
            ]
          : [],
      };
      const ev = ledger.append(
        projectId,
        {
          type: 'unwrap.computed',
          entity: { type: 'unwrapTree', key: `${region.regionId}:${variant}` },
          payload,
          refs: [src.phase, cutEv.eventId, regionEventId],
          actor: 'algorithm',
        },
        () => clock.now(),
      );
      unwrapEventIds.push(ev.eventId);

      // --- integers：保留全部合法候选（采纳与否由人工决定） ---
      const amb = enumerateIntegerCandidates(tree, params);
      const intPayload: IntegerCandidatesContent = {
        algorithmVersion: ALGO_VERSION,
        parameterFingerprint: pf,
        derivesFrom: { unwrapTreeEventId: ev.eventId, cutNetworkEventId: cutEv.eventId },
        ambiguities: amb,
        diagnostics: amb.some((a) => a.nonUnique)
          ? [{ code: 'INTEGER_MULTIPLICITY', severity: 'warning', message: '整周多解，保留全部合法候选' }]
          : [],
      };
      const intEv = ledger.append(
        projectId,
        {
          type: 'integers.computed',
          entity: { type: 'integerCandidates', key: `${region.regionId}:${variant}` },
          payload: intPayload,
          refs: [ev.eventId, cutEv.eventId],
          actor: 'algorithm',
        },
        () => clock.now(),
      );
      integerEventIds.push(intEv.eventId);

      // --- height chain（用当前波长/几何/标定） ---
      const wl = ledger.getEvent(src.wavelength)!.payload as {
        value: { normalized: number | null };
      };
      const geo = ledger.getEvent(src.geometry)!.payload as {
        kVector: { x: number; y: number; z: number } | null;
      };
      const sNormal = geo.kVector === null ? null : sensitivityNormal(geo.kVector);
      const reference = new Float64Array(frames.rows * frames.cols).fill(0);
      const chain = buildHeightChain({
        unwrapped: tree.unwrapped,
        wavelengthMeters: wl.value.normalized,
        sensitivityNormal: sNormal,
        referenceHeightMeters: reference,
        rows: frames.rows,
        cols: frames.cols,
      });
      const heightTileIds = rasterToTiles(Array.from(chain.height), frames.rows, frames.cols).map((t) =>
        ledger.putTile(t),
      );
      const steps = chain.steps.map((s) => ({
        ...s,
        inputs: s.inputs.map((inp) => ({
          ...inp,
          contentRef:
            inp.name === 'lambda'
              ? src.wavelength
              : inp.name === 'calibration'
                ? src.calibration
                : inp.name === 'unwrapped'
                  ? ev.eventId
                  : null,
        })),
      }));
      const hPayload: HeightChainContent = {
        algorithmVersion: HEIGHT_ALGO_VERSION,
        parameterFingerprint: pf,
        derivesFrom: {
          unwrapTreeEventId: ev.eventId,
          integerCandidatesEventId: intEv.eventId,
          wavelengthEventId: src.wavelength,
          geometryEventId: src.geometry,
          calibrationEventId: src.calibration,
        },
        steps,
        heightContentId: 'frame:' + heightTileIds.join(','),
        heightUnit: 'meter',
        diagnostics: chain.steps
          .filter((s) => s.diagnostic)
          .map((s) => ({
            code: s.diagnostic!,
            severity: 'warning' as const,
            message: `高度链步骤${s.index}：${s.diagnostic}`,
          })),
      };
      const hEv = ledger.append(
        projectId,
        {
          type: 'height.computed',
          entity: { type: 'heightChain', key: `${region.regionId}:${variant}` },
          payload: hPayload,
          refs: [ev.eventId, intEv.eventId, src.wavelength, src.geometry, src.calibration],
          actor: 'algorithm',
        },
        () => clock.now(),
      );
      heightEventIds.push(hEv.eventId);
    }
  }

  return {
    quality: ctx.qualityEventId,
    residues: residueEventId,
    regions: regionEventId,
    cuts: cutEv.eventId,
    unwrap: unwrapEventIds,
    integers: integerEventIds,
    height: heightEventIds,
    diagnostics: ctx.diagnostics,
  };
}
