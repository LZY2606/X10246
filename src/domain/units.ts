import type {
  AmplitudeUnit,
  CellDiagnostic,
  InputBundle,
  LengthUnit,
  PhaseUnit,
  RawGrid,
  RawTile,
  SnrUnit,
} from './vocabulary.ts';

/** 单位转换失败不是异常吞掉：值留在原位置并附诊断。 */
export class UnitConversionError extends Error {
  constructor(
    readonly rawRepresentation: string,
    readonly targetUnit: string,
  ) {
    super(`无法把 "${rawRepresentation}" 规范化为 ${targetUnit}`);
  }
}

const LENGTH_TO_M: Record<LengthUnit, number> = {
  nm: 1e-9,
  um: 1e-6,
  mm: 1e-3,
  m: 1,
};

export function convertLength(value: number, from: LengthUnit, to: LengthUnit): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new UnitConversionError(String(value), to);
  }
  return (value * LENGTH_TO_M[from]) / LENGTH_TO_M[to];
}

export function convertPhaseToRad(value: number, from: PhaseUnit): number {
  if (!Number.isFinite(value)) throw new UnitConversionError(String(value), 'rad');
  if (from === 'rad') return value;
  if (from === 'cycle') return value * 2 * Math.PI;
  return (value * Math.PI) / 180;
}

export function convertSnr(value: number, from: SnrUnit, to: SnrUnit): number {
  if (!Number.isFinite(value)) throw new UnitConversionError(String(value), to);
  if (from === to) return value;
  if (from === 'linear' && to === 'dB') {
    if (value <= 0) throw new UnitConversionError(String(value), 'dB');
    return 10 * Math.log10(value);
  }
  return 10 ** (value / 10);
}

export type AmplitudeKind = AmplitudeUnit;

export function validateAmplitude(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * 把瓦片包合并为一张网格。
 * - 原始表示逐位保留（值与单位都不动）；
 * - 重叠像素不一致时报 duplicate-tile-cell，不猜测哪一份对；
 * - 逐格记录来源瓦片（tileOrigin 用 tileId 表索引，便于“共享片段只存一份”）。
 */
export function assembleBundle(bundle: InputBundle): RawGrid {
  const { rows, cols } = bundle.basis;
  const n = rows * cols;
  const phase = new Float64Array(n).fill(NaN);
  const amplitude = new Float64Array(n).fill(NaN);
  const invalid = new Uint8Array(n);
  const invalidReason: (string | null)[] = new Array(n).fill(null);
  const tileOrigin = new Int32Array(n).fill(-1);
  const seenPhaseUnit = new Set<string>();
  const seenAmpUnit = new Set<string>();
  const diagnostics: CellDiagnostic[] = [];

  bundle.tiles.forEach((tile: RawTile, tileIdx) => {
    seenPhaseUnit.add(tile.phaseUnit);
    seenAmpUnit.add(tile.amplitudeUnit);
    for (let tr = 0; tr < tile.rows; tr++) {
      for (let tc = 0; tc < tile.cols; tc++) {
        const local = tr * tile.cols + tc;
        const r = tile.offsetRow + tr;
        const c = tile.offsetCol + tc;
        if (r < 0 || c < 0 || r >= rows || c >= cols) {
          diagnostics.push({
            index: r * cols + c,
            code: 'out-of-unit-range',
            rawRepresentation: `tile=${tile.tileId}`,
            detail: `瓦片 ${tile.tileId} 单元 (${tr},${tc}) 超出网格 ${rows}x${cols}`,
          });
          continue;
        }
        const idx = r * cols + c;
        const p = tile.phase[local];
        const a = tile.amplitude[local];
        if (p === undefined || a === undefined) continue;
        if (tileOrigin[idx] !== -1) {
          const prevPhase = phase[idx];
          if (Number.isFinite(prevPhase) && Math.abs(prevPhase - p) > 1e-12) {
            diagnostics.push({
              index: idx,
              code: 'duplicate-tile-cell',
              rawRepresentation: String(p),
              detail: `瓦片 ${tile.tileId} 与瓦片 #${tileOrigin[idx]} 在该像素给出不一致原始相位`,
            });
            continue;
          }
        }
        if (!Number.isFinite(p)) {
          diagnostics.push({
            index: idx,
            code: 'unparseable-value',
            rawRepresentation: String(p),
            detail: '包裹相位不是有限数，保留 NaN，不猜测',
          });
        }
        if (!validateAmplitude(a)) {
          diagnostics.push({
            index: idx,
            code: 'unparseable-value',
            rawRepresentation: String(a),
            detail: '振幅为负或非有限数，保留 NaN',
          });
        }
        phase[idx] = p;
        amplitude[idx] = a;
        invalid[idx] = tile.invalid[local] ?? 0;
        invalidReason[idx] = tile.invalidReason[local] ?? null;
        tileOrigin[idx] = tileIdx;
      }
    }
  });

  if (seenPhaseUnit.size > 1 || seenAmpUnit.size > 1) {
    diagnostics.push({
      index: -1,
      code: 'unit-conversion-rejected',
      rawRepresentation: [...seenPhaseUnit, ...seenAmpUnit].join(','),
      detail: '同一网格的原始单位不一致；规范化在派生层逐值进行，此处不覆盖原始单位',
    });
  }

  for (let idx = 0; idx < n; idx++) {
    if (tileOrigin[idx] === -1) {
      invalid[idx] = 1;
      invalidReason[idx] ??= 'uncovered-by-tile';
    }
  }

  return {
    rows,
    cols,
    phase,
    phaseUnit: bundle.tiles[0]?.phaseUnit ?? 'rad',
    amplitude,
    amplitudeUnit: bundle.tiles[0]?.amplitudeUnit ?? 'adu',
    invalid,
    invalidReason,
    snrProvided: bundle.snr ? bundle.snr.values.slice() : null,
    snrUnit: bundle.snr ? bundle.snr.unit : null,
    diagnostics,
    tileOrigin,
    bundleId: bundle.bundleId,
  };
}
