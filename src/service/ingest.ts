/**
 * 导入层：把可复制的小型样例（场景）提交为不可变输入实体。
 *  - 原相位像素 / 振幅 / 信噪 / 遮罩为帧（瓦片去重，共享片段只存一份）；
 *  - 波长 / 入射几何 / 标定面 / 切口历史为独立不可变实体；
 *  - 保留原始表示 rawRepresentation；导入层接受明确的格式错误并给诊断。
 */
import type { Ledger } from '../db/ledger.ts';
import { VirtualClock } from '../domain/rng.ts';
import { rasterToTiles } from '../domain/frames.ts';
import { makeValue } from '../domain/units.ts';
import { GRID, buildMinimalScene, buildCombinedScene, type RawScene, type ScenarioKey } from '../domain/scenarios.ts';
import type {
  CalibrationSurfaceContent,
  FrameContent,
  FrameTile,
  IncidenceGeometryContent,
  WavelengthContent,
} from '../domain/types.ts';

export interface IngestResult {
  ids: Record<string, string>;
  tiles: { total: number; unique: number };
}

interface FrameImport {
  kind: 'wrappedPhase' | 'amplitude' | 'qualityScore' | 'invalidMask';
  unit: FrameContent['unit'];
  values: number[];
  sourceUnitText: string;
}

function importFrame(
  ledger: Ledger,
  projectId: string,
  clock: VirtualClock,
  fi: FrameImport,
): { contentId: string; key: string; eventId: string; tileCount: number; uniqueTiles: number } {
  const rows = GRID.rows;
  const cols = GRID.cols;
  const tiles: FrameTile[] = rasterToTiles(fi.values, rows, cols);
  const before = new Set(ledger.allTiles().map((t) => t.content_id));
  const tileIds = tiles.map((t) => ledger.putTile(t));
  const uniqueTiles = tileIds.filter((id) => !before.has(id)).length;

  const entityType =
    fi.kind === 'wrappedPhase'
      ? 'wrappedPhaseFrame'
      : fi.kind === 'amplitude'
        ? 'amplitudeFrame'
        : fi.kind === 'qualityScore'
          ? 'qualityScoreFrame'
          : 'invalidMaskFrame';

  const content: FrameContent = {
    kind: fi.kind,
    unit: fi.unit,
    basis: 'pixel-grid',
    rows,
    cols,
    placements: tiles.map((t, i) => ({
      tileContentId: tileIds[i],
      originR: t.blockR * 4,
      originC: t.blockC * 4,
    })),
    rawRepresentation: {
      encoding: 'float64-rows',
      sourceUnitText: fi.sourceUnitText,
      endianness: 'little',
      scale: 1,
      offset: 0,
    },
  };
  const key = fi.kind;
  const ev = ledger.append(
    projectId,
    {
      type: 'frame.imported',
      entity: { type: entityType as never, key },
      payload: content,
      refs: [],
      actor: 'human',
      tiles,
    },
    () => clock.now(),
  );
  return {
    contentId: ev.contentId,
    key,
    eventId: ev.eventId,
    tileCount: tiles.length,
    uniqueTiles,
  };
}

export function ingestScene(
  ledger: Ledger,
  projectId: string,
  clock: VirtualClock,
  scene: RawScene,
): IngestResult {
  const ids: Record<string, string> = {};
  const phase = importFrame(ledger, projectId, clock, {
    kind: 'wrappedPhase',
    unit: 'radian',
    values: scene.phase,
    sourceUnitText: 'rad[-pi,pi)',
  });
  ids.phase = phase.eventId;
  const amp = importFrame(ledger, projectId, clock, {
    kind: 'amplitude',
    unit: 'count',
    values: scene.amplitude,
    sourceUnitText: 'grayscale[0,1]',
  });
  ids.amplitude = amp.eventId;
  const snr = importFrame(ledger, projectId, clock, {
    kind: 'qualityScore',
    unit: 'dimensionless',
    values: scene.snr,
    sourceUnitText: 'snr[0,1]',
  });
  ids.snr = snr.eventId;
  const mask = importFrame(ledger, projectId, clock, {
    kind: 'invalidMask',
    unit: 'count',
    values: scene.mask,
    sourceUnitText: 'mask{1=valid}',
  });
  ids.mask = mask.eventId;

  ids.wavelength = ingestWavelength(ledger, projectId, clock, 632.8, 'nanometer', 'He-Ne v1').eventId;
  ids.geometry = ingestGeometry(ledger, projectId, clock, 35, 0).eventId;
  ids.calibration = ingestCalibration(ledger, projectId, clock).eventId;
  ids.cutHistory = ingestEmptyCutHistory(ledger, projectId, clock).eventId;

  const totalTiles = phase.tileCount + amp.tileCount + snr.tileCount + mask.tileCount;
  const uniqueTiles = phase.uniqueTiles + amp.uniqueTiles + snr.uniqueTiles + mask.uniqueTiles;
  return { ids, tiles: { total: totalTiles, unique: uniqueTiles } };
}

export function ingestWavelength(
  ledger: Ledger,
  projectId: string,
  clock: VirtualClock,
  raw: number,
  unit: 'nanometer' | 'micrometer' | 'meter',
  label: string,
  parentVersionEventId?: string,
) {
  const value = makeValue({ raw, unit, basis: null });
  const content: WavelengthContent = {
    value,
    label,
    rawRepresentation: { sourceText: String(raw), unitText: unit },
  };
  const ev = ledger.append(
    projectId,
    {
      type: 'wavelength.revised',
      entity: { type: 'wavelength', key: 'main' },
      payload: content,
      refs: [],
      actor: 'human',
      parentVersionEventId: parentVersionEventId ?? null,
    },
    () => clock.now(),
  );
  return ev;
}

export function ingestGeometry(
  ledger: Ledger,
  projectId: string,
  clock: VirtualClock,
  incidenceDeg: number,
  azimuthDeg: number,
  parentVersionEventId?: string,
) {
  const incidenceAngle = makeValue({ raw: incidenceDeg, unit: 'degree', basis: 'object-surface' });
  const azimuth = makeValue({ raw: azimuthDeg, unit: 'degree', basis: 'object-surface' });
  const theta = incidenceAngle.normalized ?? NaN;
  const az = azimuth.normalized ?? NaN;
  const kVector =
    Number.isFinite(theta) && Number.isFinite(az)
      ? {
          x: Math.sin(theta) * Math.cos(az),
          y: Math.sin(theta) * Math.sin(az),
          z: -Math.cos(theta),
        }
      : null;
  const content: IncidenceGeometryContent = {
    incidenceAngle,
    azimuth,
    kVector,
    rawRepresentation: { sourceText: `angle=${incidenceDeg}deg,az=${azimuthDeg}deg` },
  };
  return ledger.append(
    projectId,
    {
      type: 'geometry.revised',
      entity: { type: 'incidenceGeometry', key: 'main' },
      payload: content,
      refs: [],
      actor: 'human',
      parentVersionEventId: parentVersionEventId ?? null,
    },
    () => clock.now(),
  );
}

export function ingestCalibration(
  ledger: Ledger,
  projectId: string,
  clock: VirtualClock,
  parentVersionEventId?: string,
  constantMeters = 0,
) {
  const content: CalibrationSurfaceContent = {
    kind: 'plane',
    plane: { normal: { x: 0, y: 0, z: 1 }, constantMeters },
    rawRepresentation: { sourceText: 'z=0 reference plane', unitText: 'meter' },
  };
  return ledger.append(
    projectId,
    {
      type: 'calibration.revised',
      entity: { type: 'calibrationSurface', key: 'main' },
      payload: content,
      refs: [],
      actor: 'human',
      parentVersionEventId: parentVersionEventId ?? null,
    },
    () => clock.now(),
  );
}

export function ingestEmptyCutHistory(
  ledger: Ledger,
  projectId: string,
  clock: VirtualClock,
) {
  return ledger.append(
    projectId,
    {
      type: 'cut.edited',
      entity: { type: 'cutEditHistory', key: 'main' },
      payload: { edits: [], rawRepresentation: {} },
      refs: [],
      actor: 'system',
    },
    () => clock.now(),
  );
}

export { buildMinimalScene, buildCombinedScene, GRID };
export type { ScenarioKey };
