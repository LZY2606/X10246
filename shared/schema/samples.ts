import { SeededRng } from '../domain/rng.js';
import { wrapToPi, TWO_PI } from '../domain/geometry.js';
import type {
  AmplitudeInput,
  CalibrationPlaneInput,
  CutEditHistoryInput,
  IlluminationGeometryInput,
  InvalidMaskInput,
  WavelengthInput,
  WrappedPhaseInput
} from '../domain/types.js';

/**
 * 可复制的小型样例（固定 seed）。
 * 相位模型：phi = wrap(kx*u + ky*v + tilt*u*v)，振幅=1+噪声，
 * 可叠加相位跨越、孔洞、多连通、残差等情形。
 */
export interface SampleOptions {
  width: number;
  height: number;
  seed: number;
  /** 相位空间频率（rad/px） */
  kx: number;
  ky: number;
  /** 二次倾斜，制造残差/循环不闭合 */
  saddle: number;
  /** 在像素处强制 +/-pi 跨越（u,v 列表） */
  wrapSeams?: [number, number][];
  /** 低振幅孔洞（矩形列表） */
  holes?: { u0: number; v0: number; u1: number; v1: number }[];
  /** 无效遮罩像素（多连通区隔断） */
  maskBlocks?: { u0: number; v0: number; u1: number; v1: number }[];
  /** 在 plaquette 注入一个 +1 残差点（位置为格点 u,v） */
  residueDipoles?: { u: number; v: number; sign: 1 | -1 }[];
  noiseAmp?: number;
}

const RAD = { kind: 'angle', symbol: 'rad' } as const;
const AMP_U = { kind: 'dimensionless', symbol: 'a.u.' } as const;

function frame() {
  return {
    id: 'lab-frame',
    origin: 'top-left' as const,
    axisU: 'column' as const,
    axisV: 'row' as const,
    pitchU: { value: 0.01, unit: { kind: 'length', symbol: 'mm' } as const },
    pitchV: { value: 0.01, unit: { kind: 'length', symbol: 'mm' } as const }
  };
}

export function makeWrappedPhase(opts: SampleOptions, frameId = 'cam-0'): WrappedPhaseInput {
  const { width: w, height: h } = opts;
  const rng = new SeededRng(opts.seed);
  const raw: number[] = [];
  const rep: string[] = [];
  const seamSet = new Set((opts.wrapSeams ?? []).map(([u, v]) => `${u},${v}`));
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      // 未包裹相位上的支路阶跃：对 plaquette(d.u,d.v) 的右下象限（u>d.u 且 v>d.v）
      // 叠加 2π*sign；包裹后竖边与横边各跨越一次边界，2x2 缠绕和恰为 ±2π（一个电荷）。
      // 局部点残差：只在以 (d.u,d.v) 为左上角的单个 2x2 plaquette 内加偏移，
      // 四角相对值 TL=0, TR=π, BR=2π(包裹为0), BL=π => 缠绕和=2π（一个 +1 电荷）。
      let branchOffset = 0;
      for (const d of opts.residueDipoles ?? []) {
        if (u === d.u && v === d.v) branchOffset += 0;
        else if (u === d.u + 1 && v === d.v) branchOffset += d.sign * Math.PI;
        else if (u === d.u && v === d.v + 1) branchOffset += d.sign * Math.PI;
        else if (u === d.u + 1 && v === d.v + 1) branchOffset += d.sign * 2 * Math.PI;
      }
      let phi = opts.kx * u + opts.ky * v + opts.saddle * (u - w / 2) * (v - h / 2) + branchOffset;
      if (seamSet.has(`${u},${v}`)) phi = phi > 0 ? Math.PI - 0.02 : -Math.PI + 0.02;
      phi += (rng.next() - 0.5) * (opts.noiseAmp ?? 0.0);
      const wv = wrapToPi(phi);
      raw.push(wv);
      rep.push(wv.toFixed(6));
    }
  }
  return {
    kind: 'wrapped_phase',
    frameId,
    width: w,
    height: h,
    raw,
    rawRepresentation: rep,
    range: { minInclusive: -Math.PI, maxExclusive: Math.PI, unit: RAD },
    coordinateFrame: frame()
  };
}

export function makeAmplitude(opts: SampleOptions, frameId = 'cam-0'): AmplitudeInput {
  const { width: w, height: h } = opts;
  const rng = new SeededRng(opts.seed + 99);
  const raw: number[] = [];
  const rep: string[] = [];
  const inHole = (u: number, v: number) =>
    (opts.holes ?? []).some((r) => u >= r.u0 && u <= r.u1 && v >= r.v0 && v <= r.v1);
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      let amp = 1 + (rng.next() - 0.5) * 0.05;
      if (inHole(u, v)) amp = 0.05;
      raw.push(Number(amp.toFixed(4)));
      rep.push(amp.toFixed(4));
    }
  }
  return {
    kind: 'amplitude',
    frameId, width: w, height: h, raw, rawRepresentation: rep, unit: AMP_U
  };
}

export function makeMask(opts: SampleOptions, frameId = 'cam-0'): InvalidMaskInput {
  const { width: w, height: h } = opts;
  const valid = new Array<0 | 1>(w * h).fill(1);
  for (const r of opts.maskBlocks ?? []) {
    for (let v = r.v0; v <= r.v1; v++)
      for (let u = r.u0; u <= r.u1; u++)
        if (u < w && v < h) valid[v * w + u] = 0;
  }
  return { kind: 'invalid_mask', frameId, width: w, height: h, valid, reason: 'sample_mask' };
}

export function makeWavelength(lambda = 632.8): WavelengthInput {
  return {
    kind: 'wavelength',
    value: lambda,
    rawRepresentation: `${lambda} nm`,
    unit: { kind: 'length', symbol: 'nm' }
  };
}

export function makeGeometry(): IlluminationGeometryInput {
  // 斜入射，灵敏度沿 z 有明确分量
  return {
    kind: 'illumination_geometry',
    sourceDirection: { x: 0.3, y: 0, z: 0.9539 },
    observerDirection: { x: 0, y: 0, z: 1 },
    sensitivityHint: { x: -0.3, y: 0, z: 0.0461 },
    rawRepresentation: 'in=(0.3,0,0.9539); obs=(0,0,1)',
    coordinateFrame: frame()
  };
}

export function makeCalibration(): CalibrationPlaneInput {
  return {
    kind: 'calibration_plane',
    normal: { x: 0, y: 0, z: 1 },
    offset: 0,
    offsetUnit: { kind: 'length', symbol: 'm' },
    residualRms: 0.0021,
    residualUnit: { kind: 'length', symbol: 'mm' },
    rawRepresentation: 'plane z=0, rms=0.0021 mm'
  };
}

export function makeEmptyCutHistory(): CutEditHistoryInput {
  return { kind: 'cut_edit_history', entries: [] };
}

/** 把样本打包为导入层接受的 JSON 形态（含原始字符串表示） */
export function sampleBundleJson(opts: SampleOptions) {
  const phase = makeWrappedPhase(opts);
  const amplitude = makeAmplitude(opts);
  const mask = makeMask(opts);
  return {
    wrapped_phase: {
      frameId: phase.frameId, width: phase.width, height: phase.height,
      values: phase.raw, rangeMin: -Math.PI, rangeMax: Math.PI,
      unit: RAD, coordinateFrame: phase.coordinateFrame
    },
    amplitude: {
      frameId: amplitude.frameId, width: amplitude.width, height: amplitude.height,
      values: amplitude.raw, unit: AMP_U
    },
    invalid_mask: {
      frameId: mask.frameId, width: mask.width, height: mask.height, valid: mask.valid, reason: mask.reason
    },
    wavelength: { value: 632.8, unit: { kind: 'length', symbol: 'nm' } },
    illumination_geometry: {
      sourceDirection: makeGeometry().sourceDirection,
      observerDirection: makeGeometry().observerDirection,
      sensitivityHint: makeGeometry().sensitivityHint,
      coordinateFrame: frame()
    },
    calibration_plane: {
      normal: makeCalibration().normal,
      offset: 0,
      offsetUnit: { kind: 'length', symbol: 'm' },
      residualRms: 0.0021,
      residualUnit: { kind: 'length', symbol: 'mm' }
    },
    cut_edit_history: { entries: [] }
  };
}

export { TWO_PI };
