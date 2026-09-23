/**
 * 离线案例包“干涉条纹簿：相位展开、支路切口与光学标定分支”。
 * 不使用通用表格：材料直接是包裹相位/振幅/遮罩等领域帧。
 *
 * 固定 seed + 确定性构造，覆盖 7 种情形：
 *  phase-border-crossing / low-amplitude-hole / multiply-connected /
 *  cycle-not-closed / wavelength-version / integer-ambiguity / lock-conflict
 *
 * 每个情形有“最小输入”和“组合输入”。二者共享的原始 4x4 片段（瓦片）
 * 内容相同 -> 同一 contentId，只存一份不可变内容；解释版本/诊断/人工决定独立。
 */
import { mulberry32 } from './rng.ts';
import { wrapToPi, TWO_PI } from './units.ts';
import { BLOCK, rasterToTiles } from './frames.ts';
import type { FrameTile } from './types.ts';

export const SCENARIO_KEYS = [
  'phase-border-crossing',
  'low-amplitude-hole',
  'multiply-connected',
  'cycle-not-closed',
  'wavelength-version',
  'integer-ambiguity',
  'lock-conflict',
] as const;
export type ScenarioKey = (typeof SCENARIO_KEYS)[number];

export interface RawScene {
  rows: number;
  cols: number;
  phase: number[]; // 包裹相位 rad
  amplitude: number[];
  snr: number[];
  mask: number[]; // 1 有效
  /** 该场景刻意呈现的特征坐标（供测试断言/界面标注）。 */
  features: Record<string, Array<{ r: number; c: number }>>;
}

const ROWS = 8;
const COLS = 8;

function baseScene(seedText: string): {
  phase: number[];
  amplitude: number[];
  snr: number[];
  mask: number[];
  rand: () => number;
} {
  const rand = mulberry32(hash(seedText));
  const n = ROWS * COLS;
  const phase = new Array(n).fill(0);
  const amplitude = new Array(n).fill(0.9);
  const snr = new Array(n).fill(0.9);
  const mask = new Array(n).fill(1);
  // 平滑倾斜条纹：真实相位 = 2π*(0.55*r + 0.30*c)/? 产生自然的 ±π 边界穿越
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const truePhi = TWO_PI * (0.42 * r + 0.2 * c);
      phase[r * COLS + c] = wrapToPi(truePhi);
    }
  }
  void rand;
  return { phase, amplitude, snr, mask, rand };
}

function hash(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 最小输入：仅含触发该情形所需的最小构造。 */
export function buildMinimalScene(key: ScenarioKey): RawScene {
  const s = baseScene('min:' + key);
  const features: RawScene['features'] = {};
  const setLowAmp = (r: number, c: number) => {
    s.amplitude[r * COLS + c] = 0.05;
    s.snr[r * COLS + c] = 0.1;
  };

  switch (key) {
    case 'phase-border-crossing': {
      // 强化斜坡，使某行在 c 边界处从 +π 跳到 -π（真实 2π 跨越）
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          s.phase[r * COLS + c] = wrapToPi(TWO_PI * (0.5 * r + 0.55 * c));
        }
      }
      features.borderJumps = [{ r: 0, c: 1 }, { r: 0, c: 5 }];
      break;
    }
    case 'low-amplitude-hole': {
      const hole = [
        { r: 3, c: 3 },
        { r: 3, c: 4 },
        { r: 4, c: 3 },
        { r: 4, c: 4 },
      ];
      for (const p of hole) {
        setLowAmp(p.r, p.c);
        s.mask[p.r * COLS + p.c] = 1; // 仍有效但低振幅：系统不得猜相位
      }
      features.lowAmplitudeHole = hole;
      break;
    }
    case 'multiply-connected': {
      // 遮罩挖出一个与外边界不相连的孔洞 -> 区域多连通
      const hole = [
        { r: 3, c: 3 },
        { r: 3, c: 4 },
        { r: 4, c: 3 },
        { r: 4, c: 4 },
      ];
      for (const p of hole) s.mask[p.r * COLS + p.c] = 0;
      features.maskedHole = hole;
      break;
    }
    case 'cycle-not-closed': {
      // 注入一个真实残差：在 2x2 单元把一个像素的包裹相位额外加 1.3 rad，
      // 使环绕和不为 2π 整数（无法仅靠整周闭合）。
      const { phase } = s;
      phase[2 * COLS + 2] = wrapToPi(phase[2 * COLS + 2] + 1.3);
      features.residueInjection = [{ r: 2, c: 2 }];
      break;
    }
    case 'wavelength-version': {
      // 帧本身平滑；情形由“波长修订”事件驱动（在 builder 里）。
      features.wavelengthTarget = [{ r: 0, c: 0 }];
      break;
    }
    case 'integer-ambiguity': {
      // 跨切口多解：制造一对正负残差 + 低振幅隔离，使整周无法唯一。
      s.phase[2 * COLS + 4] = wrapToPi(s.phase[2 * COLS + 4] + TWO_PI * 0.5);
      s.phase[5 * COLS + 4] = wrapToPi(s.phase[5 * COLS + 4] - TWO_PI * 0.5);
      for (const p of [
        { r: 3, c: 4 },
        { r: 4, c: 4 },
      ]) setLowAmp(p.r, p.c);
      features.ambiguityZone = [
        { r: 2, c: 4 },
        { r: 5, c: 4 },
        { r: 3, c: 4 },
      ];
      break;
    }
    case 'lock-conflict': {
      // 同一区域存在两种局部自洽解读（两棵树），供两次相互冲突的人工锁定。
      s.phase[3 * COLS + 3] = wrapToPi(s.phase[3 * COLS + 3] + TWO_PI * 0.5);
      s.phase[4 * COLS + 4] = wrapToPi(s.phase[4 * COLS + 4] - TWO_PI * 0.5);
      features.lockZone = [
        { r: 3, c: 3 },
        { r: 4, c: 4 },
      ];
      break;
    }
  }
  return { rows: ROWS, cols: COLS, phase: s.phase, amplitude: s.amplitude, snr: s.snr, mask: s.mask, features };
}

/** 组合输入：在同一 8x8 上叠加多个情形，共享同样的 4x4 瓦片网格。 */
export function buildCombinedScene(keys: ScenarioKey[]): RawScene {
  const s = baseScene('combined:' + keys.join('+'));
  const features: RawScene['features'] = {};
  for (const key of keys) {
    const mini = buildMinimalScene(key);
    // 只搬移“特征性”改动，避免整体覆盖：对低振幅/遮罩/注入点做合并
    for (let i = 0; i < s.phase.length; i++) {
      const r = Math.floor(i / COLS);
      const c = i % COLS;
      if (mini.amplitude[i] < 0.2 && s.amplitude[i] > mini.amplitude[i]) s.amplitude[i] = mini.amplitude[i];
      if (mini.snr[i] < 0.2 && s.snr[i] > mini.snr[i]) s.snr[i] = mini.snr[i];
      if (mini.mask[i] === 0) s.mask[i] = 0;
    }
    // 注入点（cycle / ambiguity / lock / border）采用 mini 的相位
    for (const [name, pts] of Object.entries(mini.features)) {
      features[name] = [...(features[name] ?? []), ...pts];
      for (const p of pts) {
        if (
          name === 'residueInjection' ||
          name === 'ambiguityZone' ||
          name === 'lockZone' ||
          name === 'borderJumps'
        ) {
          s.phase[p.r * COLS + p.c] = mini.phase[p.r * COLS + p.c];
        }
      }
    }
  }
  return { rows: ROWS, cols: COLS, phase: s.phase, amplitude: s.amplitude, snr: s.snr, mask: s.mask, features };
}

/** 栅格 -> 瓦片（共享内容时哈希一致）。 */
export function sceneTiles(kind: 'phase' | 'amplitude' | 'snr' | 'mask', values: number[]): FrameTile[] {
  const rows = ROWS;
  const cols = COLS;
  const ras = new Float64Array(values);
  return rasterToTiles(Array.from(ras), rows, cols);
}

export const GRID = { rows: ROWS, cols: COLS, block: BLOCK };
