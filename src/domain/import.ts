import type {
  AmplitudeFrame,
  CalibrationSurface,
  CoordinateBasis,
  CutEdge,
  CutEditHistory,
  Diagnostic,
  IlluminationGeometry,
  InvalidMask,
  Quant,
  QualityScoreMap,
  Wavelength,
  WrappedPhaseFrame,
} from './types.js';
import { ImportFormatError } from './types.js';
import { normalizeQuant, wrapToPrincipal } from './units.js';
import { contentHash, parameterFingerprint, stableId } from './hash.js';

/**
 * 导入包：光学实验室提交的原始材料。可复制、小型、自描述。
 * 原相位像素、信噪评分、无效遮罩、波长、入射几何、标定面、切口编辑历史
 * 七类输入一经提交不可覆盖；修订在 store 层以「新版本 + 父版本」表达。
 */
export interface RawImportBundle {
  schema: 'interferogram-ledger/raw-import';
  schemaVersion: 1;
  capturedAt: string; // 实验室采集时间（原始表示保留）
  grid: { rows: number; cols: number; pixelPitch?: Quant };
  wrappedPhase: { unit: string; values: number[] };
  amplitude: { unit: string; values: number[] };
  quality: { values: number[]; method: string };
  invalid: { invalid: boolean[]; reason: (string | null)[] };
  wavelength: Quant;
  geometry: { incidenceAngle: Quant; sensitivityModel: string; illuminationVector: { x: number; y: number; z: number } };
  calibration: {
    model: 'plane-affine' | 'height-grid';
    plane?: { a: Quant; b: Quant; c: Quant };
    grid?: number[];
    heightUnit: string;
  };
  cutEdits?: { editor: string; note: string; added: Omit<CutEdge, 'edgeId'>[]; removed?: string[] }[];
}

const ALGO = 'import/raw-import@1';

export function parseRawImport(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ImportFormatError([
      { code: 'IMPORT_NOT_JSON', severity: 'error', message: `不是合法 JSON：${(e as Error).message}` },
    ]);
  }
}

function basis(b: RawImportBundle): CoordinateBasis {
  return {
    rows: b.grid.rows,
    cols: b.grid.cols,
    origin: 'top-left',
    physicalBasis: 'pixel-index，物理坐标由标定面给出',
    ...(b.grid.pixelPitch ? { pixelPitch: normalizeQuant(b.grid.pixelPitch) } : {}),
  };
}

type Acc = { diagnostics: Diagnostic[] };

function checkGrid(acc: Acc, name: string, arr: unknown[], n: number, finite: boolean): void {
  if (!Array.isArray(arr) || arr.length !== n) {
    acc.diagnostics.push({
      code: 'IMPORT_GRID_SIZE',
      severity: 'error',
      message: `${name} 长度必须为 rows*cols=${n}，实际 ${Array.isArray(arr) ? arr.length : typeof arr}`,
    });
  }
  if (finite) {
    arr.forEach((v, i) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        acc.diagnostics.push({
          code: 'IMPORT_NON_FINITE',
          severity: 'warning',
          message: `${name}[${i}] 非有限数值，保留原值并标记`,
          at: { r: Math.floor(i / (n || 1)), c: i % (n || 1) },
          rawValue: v,
        });
      }
    });
  }
}

/**
 * 验证并构造不可变原始实体。返回 7 类实体（切口语料可含多批编辑历史版本）。
 * 非有限相位值保留原位（不猜、不删），由下游遮罩/质量决定是否可用。
 */
export function buildRawEntities(input: unknown): {
  frames: {
    wrapped: WrappedPhaseFrame;
    amplitude: AmplitudeFrame;
    quality: QualityScoreMap;
    invalid: InvalidMask;
    wavelength: Wavelength;
    geometry: IlluminationGeometry;
    calibration: CalibrationSurface;
  };
  cutHistory: CutEditHistory[];
  diagnostics: Diagnostic[];
} {
  const acc: Acc = { diagnostics: [] };
  const b = input as RawImportBundle;

  if (!b || b.schema !== 'interferogram-ledger/raw-import' || b.schemaVersion !== 1) {
    throw new ImportFormatError([
      {
        code: 'IMPORT_BAD_SCHEMA',
        severity: 'error',
        message: '缺少 schema=interferogram-ledger/raw-import 或 schemaVersion=1',
      },
    ]);
  }

  const rows = b.grid?.rows;
  const cols = b.grid?.cols;
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0) {
    throw new ImportFormatError([
      { code: 'IMPORT_BAD_GRID', severity: 'error', message: 'grid.rows / grid.cols 必须为正整数' },
    ]);
  }
  const n = rows * cols;

  checkGrid(acc, 'wrappedPhase.values', b.wrappedPhase?.values, n, true);
  checkGrid(acc, 'amplitude.values', b.amplitude?.values, n, true);
  checkGrid(acc, 'quality.values', b.quality?.values, n, true);
  checkGrid(acc, 'invalid.invalid', b.invalid?.invalid, n, false);
  checkGrid(acc, 'invalid.reason', b.invalid?.reason, n, false);
  if (b.calibration?.model === 'height-grid') {
    checkGrid(acc, 'calibration.grid', b.calibration.grid ?? [], n, true);
  }

  const phaseValues = (b.wrappedPhase?.values ?? []).map((v: number, i: number) =>
    Number.isFinite(v) ? wrapToPrincipal(v) : (() => {
      acc.diagnostics.push({
        code: 'IMPORT_PHASE_NON_FINITE',
        severity: 'error',
        message: `原相位像素 [${i}] 非有限值，保留原始 NaN 表示，不猜测`,
        at: { r: Math.floor(i / cols), c: i % cols },
        rawValue: v,
      });
      return Number.NaN;
    })(),
  );

  const errors = acc.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) throw new ImportFormatError(acc.diagnostics);

  const coord = basis(b);
  const now = b.capturedAt ?? new Date(0).toISOString();
  const pf = parameterFingerprint(ALGO, { rows, cols });

  const make = <T extends Record<string, unknown>>(
    kind: string,
    prefix: string,
    body: Omit<T, keyof import('./types.js').RecordHeader>,
    sources = [],
  ): T => {
    const withKind = { ...body, kind };
    const hash = contentHash(withKind);
    return {
      ...(body as object),
      kind,
      entityId: stableId(prefix, body),
      versionId: stableId('ver', { kind, body }),
      parentVersionId: null,
      contentHash: hash,
      algorithmVersion: ALGO,
      parameterFingerprint: pf,
      sources,
      status: 'current',
      createdAt: now,
    } as unknown as T;
  };

  const wrapped = make<WrappedPhaseFrame>('wrapped_phase_frame', 'wph', {
    coordinateBasis: coord,
    phaseUnit: b.wrappedPhase.unit,
    principalRange: '(-pi, pi]',
    values: phaseValues,
  });

  const amplitude = make<AmplitudeFrame>('amplitude_frame', 'amp', {
    coordinateBasis: coord,
    amplitudeUnit: b.amplitude.unit,
    values: b.amplitude.values,
  });

  const quality = make<QualityScoreMap>('quality_score_map', 'qsm', {
    coordinateBasis: coord,
    scoreUnit: 'dimensionless',
    method: b.quality.method,
    values: b.quality.values,
  });

  const invalid = make<InvalidMask>('invalid_mask', 'msk', {
    coordinateBasis: coord,
    invalid: b.invalid.invalid,
    reason: b.invalid.reason,
  });

  const wavelength = make<Wavelength>('wavelength', 'wav', {
    wavelength: normalizeQuant(b.wavelength),
  });

  const geometry = make<IlluminationGeometry>('illumination_geometry', 'geo', {
    incidenceAngle: normalizeQuant(b.geometry.incidenceAngle),
    sensitivityModel: b.geometry.sensitivityModel,
    illuminationVector: b.geometry.illuminationVector,
  });

  const calibration = make<CalibrationSurface>('calibration_surface', 'cal', {
    coordinateBasis: coord,
    model: b.calibration.model,
    ...(b.calibration.model === 'plane-affine'
      ? {
          plane: {
            a: normalizeQuant(b.calibration.plane!.a),
            b: normalizeQuant(b.calibration.plane!.b),
            c: normalizeQuant(b.calibration.plane!.c),
          },
        }
      : { grid: b.calibration.grid, heightUnit: b.calibration.heightUnit }),
    heightUnit: b.calibration.heightUnit,
  });

  // 切口编辑历史：首批可能为空（表示尚无人工编辑），后续批次在 store 层形成父子版本链。
  const cutHistory: CutEditHistory[] = [];
  let parent: string | null = null;
  const batches = b.cutEdits ?? [{ editor: 'lab-import', note: '导入时无切口编辑', added: [] }];
  for (const batch of batches) {
    const added: CutEdge[] = batch.added.map((e, i) => ({
      ...e,
      edgeId: stableId('edge', { e, batch: i }),
    }));
    const body = {
      coordinateBasis: coord,
      added,
      removed: batch.removed ?? [],
      editor: batch.editor,
      note: batch.note,
    };
    const hash = contentHash({ kind: 'cut_edit_history', ...body });
    cutHistory.push({
      kind: 'cut_edit_history',
      ...body,
      entityId: stableId('cut', 'cut-edit-history'),
      versionId: stableId('ver', { kind: 'cut_edit_history', body, parent }),
      parentVersionId: parent,
      contentHash: hash,
      algorithmVersion: ALGO,
      parameterFingerprint: pf,
      sources: [],
      status: 'current',
      createdAt: now,
    });
    parent = cutHistory[cutHistory.length - 1].versionId;
  }
  // 只有多批编辑时旧版本才会被取代
  cutHistory.forEach((h, i) => {
    if (i < cutHistory.length - 1) {
      h.status = 'superseded';
      h.supersededByVersionId = cutHistory[i + 1].versionId;
    }
  });

  return {
    frames: { wrapped, amplitude, quality, invalid, wavelength, geometry, calibration },
    cutHistory,
    diagnostics: acc.diagnostics,
  };
}
