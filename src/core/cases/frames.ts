import { mulberry32 } from "../../shared/rng.js";
import { FIXED_SEED } from "../../shared/constants.js";

export interface FrameSet {
  width: number;
  height: number;
  phase: number[]; // 包裹相位 [-pi,pi)
  amplitude: number[]; // 0..1
  mask: boolean[];
  /** 真实展开相位（仅用于构造样例，不参与计算） */
  groundTruth: number[];
  description: string;
}

function blank(w: number, h: number): FrameSet {
  return {
    width: w,
    height: h,
    phase: new Array(w * h).fill(0),
    amplitude: new Array(w * h).fill(0.9),
    mask: new Array(w * h).fill(false),
    groundTruth: new Array(w * h).fill(0),
    description: "",
  };
}

function wrap(v: number): number {
  let x = v % (Math.PI * 2);
  if (x >= Math.PI) x -= Math.PI * 2;
  if (x < -Math.PI) x += Math.PI * 2;
  return x;
}

/** 倾斜平面展开相位 -> 包裹相位；在边界列制造 2pi 跨越。 */
export function phaseBoundaryFrame(w = 12, h = 8, slope = 0.95): FrameSet {
  const f = blank(w, h);
  f.description = "相位跨越边界：倾斜条纹每行多次穿越 ±π 包裹边界";
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const phi = slope * x + 0.12 * y;
      f.groundTruth[y * w + x] = phi;
      f.phase[y * w + x] = wrap(phi);
      f.amplitude[y * w + x] = 0.9 + 0.05 * Math.sin(x + y);
    }
  return f;
}

/** 中央低振幅孔洞：洞内相位不允许猜测。 */
export function lowAmplitudeHoleFrame(w = 12, h = 9): FrameSet {
  const f = phaseBoundaryFrame(w, h, 0.5);
  f.description = "低振幅孔洞：中央 3x3 振幅接近 0，禁止展开猜测";
  for (let y = 3; y <= 5; y++)
    for (let x = 4; x <= 6; x++) {
      f.amplitude[y * w + x] = 0.02;
    }
  return f;
}

/** 遮罩柱造成多连通区（环形区域 + 孤岛）。 */
export function multicomponentFrame(w = 12, h = 10): FrameSet {
  const f = phaseBoundaryFrame(w, h, 0.55);
  f.description = "多连通区：遮罩柱将视场分裂为多个 4-连通分量与孤岛";
  for (let y = 2; y <= 7; y++) f.mask[y * w + 5] = true;
  // 孤岛 (10,1) 仅与遮罩/边界相邻
  f.mask[1 * w + 9] = true;
  f.mask[2 * w + 9] = true;
  f.mask[1 * w + 11] = true;
  return f;
}

/** 注入一对 ±1 残差，使环绕积分不闭合。 */
export function cycleNonclosureFrame(w = 10, h = 8): FrameSet {
  const f = phaseBoundaryFrame(w, h, 0.3);
  f.description = "循环不闭合：在 (3,3)/(6,4) 注入异号残差，切口未给偏移时环不闭合";
  // 移动一条边上的包裹值一个 2pi 等价跳变（在包裹域制造残差）
  const flip = (x: number, y: number) => {
    f.phase[y * w + x] = wrap(f.phase[y * w + x] + Math.PI);
  };
  flip(3, 3);
  flip(6, 4);
  return f;
}

/** 组合输入：所有几何困难叠加，另加低振幅缝。 */
export function combinedFrame(seed = FIXED_SEED): FrameSet {
  const w = 16;
  const h = 12;
  const f = blank(w, h);
  const rnd = mulberry32(seed);
  f.description = "组合输入：跨越边界 + 低振幅孔洞 + 多连通遮罩 + 注入残差（固定 seed）";
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const phi = 0.8 * x + 0.22 * y + 0.5 * Math.sin(0.7 * x);
      f.groundTruth[y * w + x] = phi;
      f.phase[y * w + x] = wrap(phi);
      f.amplitude[y * w + x] = 0.75 + 0.2 * rnd();
    }
  for (let y = 4; y <= 7; y++) f.mask[y * w + 9] = true; // 分裂柱
  for (let y = 5; y <= 7; y++)
    for (let x = 3; x <= 4; x++) f.amplitude[y * w + x] = 0.01; // 低振幅孔
  f.phase[3 * w + 3] = wrap(f.phase[3 * w + 3] + Math.PI);
  f.phase[6 * w + 12] = wrap(f.phase[6 * w + 12] + Math.PI);
  return f;
}

/** 生成指定场景的最小输入；最小输入只含触发该情形的最小片段。 */
export function minimalFrame(scenario: string): FrameSet {
  switch (scenario) {
    case "phase_boundary": {
      const f = blank(6, 3);
      f.description = "最小输入：一行 6 像素跨越 ±π 边界";
      for (let x = 0; x < 6; x++) {
        const phi = 0.9 * Math.PI * x;
        f.groundTruth[x] = phi;
        f.phase[x] = wrap(phi);
      }
      for (let y = 1; y < 3; y++) for (let x = 0; x < 6; x++) f.phase[y * 6 + x] = f.phase[x];
      return f;
    }
    case "low_amplitude_hole": {
      const f = blank(5, 5);
      f.description = "最小输入：单像素低振幅孔洞 (2,2)";
      for (let y = 0; y < 5; y++)
        for (let x = 0; x < 5; x++) {
          const phi = 0.4 * x + 0.4 * y;
          f.groundTruth[y * 5 + x] = phi;
          f.phase[y * 5 + x] = wrap(phi);
        }
      f.amplitude[2 * 5 + 2] = 0.0;
      return f;
    }
    case "multicomponent": {
      const f = blank(5, 3);
      f.description = "最小输入：遮罩列分出两个分量";
      for (let i = 0; i < f.phase.length; i++) f.phase[i] = 0.3 * (i % 5);
      for (let y = 0; y < 3; y++) f.mask[y * 5 + 2] = true;
      return f;
    }
    case "cycle_nonclosure": {
      const f = blank(4, 4);
      f.description = "最小输入：2x2 单元注入 ±1 残差";
      for (let i = 0; i < 16; i++) f.phase[i] = 0.2;
      f.phase[0] = wrap(0.2 + Math.PI);
      return f;
    }
    case "wavelength_version":
    case "integer_ambiguity":
    case "lock_conflict":
    default: {
      // 这三个情形复用跨越边界最小片段（困难在解释/裁定层），共享原始片段
      const f = blank(6, 3);
      f.description = "最小输入：共享跨越边界片段（解释层情形）";
      for (let y = 0; y < 3; y++)
        for (let x = 0; x < 6; x++) {
          const phi = 0.9 * Math.PI * x;
          f.groundTruth[y * 6 + x] = phi;
          f.phase[y * 6 + x] = wrap(phi);
        }
      return f;
    }
  }
}

/** 组合输入按场景复用 combinedFrame；场景间共享的原始片段由内容哈希去重只存一份。 */
export function frameForScenario(scenario: string): FrameSet {
  switch (scenario) {
    case "phase_boundary":
      return phaseBoundaryFrame();
    case "low_amplitude_hole":
      return lowAmplitudeHoleFrame();
    case "multicomponent":
      return multicomponentFrame();
    case "cycle_nonclosure":
      return cycleNonclosureFrame();
    default:
      return combinedFrame();
  }
}
