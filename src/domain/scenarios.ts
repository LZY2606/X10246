/**
 * 七个验收情形的领域输入构造器（固定 seed，确定性）。
 * 每个情形提供一个最小输入与一个组合输入；共享原始片段内容相同（存储层按内容去重）。
 */
import { Grid, makeGrid, idx, wrapPhase } from './grid.js';
import { mulberry32 } from './rng.js';

export const SCENARIO_IDS = [
  'phase-crossing-boundary',
  'low-amplitude-hole',
  'multi-connected-region',
  'cycle-non-closure',
  'wavelength-version-change',
  'integer-multi-solution',
  'local-lock-conflict',
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];

export interface ScenarioInput {
  wrappedPhase: Grid;
  quality: Grid;
  invalidMask: Grid;
}

const W = 16;
const H = 12;

function baseQuality(fill = 0.9): Grid {
  return makeGrid(W, H, fill);
}

function rampPhase(slopeX: number, slopeY: number): Grid {
  const g = makeGrid(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) g.data[idx(g, x, y)] = wrapPhase(slopeX * x + slopeY * y);
  return g;
}

/** 1. 相位跨越边界：斜坡相位多次跨越 ±π 包裹边界。 */
export function phaseCrossingBoundary(): ScenarioInput {
  return { wrappedPhase: rampPhase(0.9, 0.35), quality: baseQuality(), invalidMask: makeGrid(W, H, 0) };
}

/** 2. 低振幅孔洞：中央圆形区域信噪评分极低，不得猜相位。 */
export function lowAmplitudeHole(): ScenarioInput {
  const quality = baseQuality();
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const dx = x - 8;
      const dy = y - 6;
      if (dx * dx + dy * dy <= 6) quality.data[idx(quality, x, y)] = 0.05;
    }
  return { wrappedPhase: rampPhase(0.6, 0.2), quality, invalidMask: makeGrid(W, H, 0) };
}

/** 3. 多连通区：遮罩竖墙把有效区分成两个互不连通的岛。 */
export function multiConnectedRegion(): ScenarioInput {
  const mask = makeGrid(W, H, 0);
  for (let y = 0; y < H; y++) mask.data[idx(mask, 8, y)] = 1;
  return { wrappedPhase: rampPhase(0.5, 0.3), quality: baseQuality(), invalidMask: mask };
}

function setPx(g: ReturnType<typeof rampPhase>, x: number, y: number, v: number) {
  g.data[idx(g, x, y)] = v;
}

/** 在 (px,py) 放置一个 +1 残差环路（四角相位 0, π/2, π, -π/2）。 */
export function craftResiduePlus(g: ReturnType<typeof rampPhase>, px: number, py: number) {
  setPx(g, px, py, 0);
  setPx(g, px + 1, py, Math.PI / 2);
  setPx(g, px + 1, py + 1, Math.PI);
  setPx(g, px, py + 1, -Math.PI / 2);
}

/** 在 (px,py) 放置一个 -1 残差环路。 */
export function craftResidueMinus(g: ReturnType<typeof rampPhase>, px: number, py: number) {
  setPx(g, px, py, 0);
  setPx(g, px + 1, py, -Math.PI / 2);
  setPx(g, px + 1, py + 1, -Math.PI);
  setPx(g, px, py + 1, Math.PI / 2);
}

/** 单个 π 尖峰：周围四个环路各产生一个不可配对的负残差。 */
export function craftSpike(g: ReturnType<typeof rampPhase>, x: number, y: number) {
  g.data[idx(g, x, y)] = wrapPhase(g.data[idx(g, x, y)] + Math.PI);
}

/** 4. 循环不闭合：残差偶极子 + 一个不可配对尖峰，展开后仍有非零环路残差。 */
export function cycleNonClosure(): ScenarioInput {
  const g = rampPhase(0.4, 0.25);
  craftResiduePlus(g, 3, 3);
  craftResidueMinus(g, 12, 8);
  craftSpike(g, 8, 5);
  return { wrappedPhase: g, quality: baseQuality(), invalidMask: makeGrid(W, H, 0) };
}

/** 5. 波长版本变更：同一包裹相位，标定波长 632.8nm → 635.0nm。 */
export function wavelengthVersionChange(): ScenarioInput {
  return { wrappedPhase: rampPhase(0.7, 0.15), quality: baseQuality(), invalidMask: makeGrid(W, H, 0) };
}

/** 6. 整周多解：两对残差偶极子，切口配对方式不同 → 多棵展开树都局部一致。 */
export function integerMultiSolution(): ScenarioInput {
  const g = rampPhase(0.35, 0.2);
  craftResiduePlus(g, 2, 2);
  craftResidueMinus(g, 13, 2);
  craftResiduePlus(g, 2, 8);
  craftResidueMinus(g, 13, 8);
  return { wrappedPhase: g, quality: baseQuality(), invalidMask: makeGrid(W, H, 0) };
}

/** 7. 局部锁定冲突：用于人工决定冲突的相位场（缓坡 + 局部跳变）。 */
export function localLockConflict(): ScenarioInput {
  const g = rampPhase(0.3, 0.2);
  for (let y = 4; y < 8; y++)
    for (let x = 4; x < 10; x++) {
      const i = idx(g, x, y);
      g.data[i] = wrapPhase(g.data[i] + 1.2);
    }
  return { wrappedPhase: g, quality: baseQuality(), invalidMask: makeGrid(W, H, 0) };
}

export const SCENARIO_BUILDERS: Record<ScenarioId, () => ScenarioInput> = {
  'phase-crossing-boundary': phaseCrossingBoundary,
  'low-amplitude-hole': lowAmplitudeHole,
  'multi-connected-region': multiConnectedRegion,
  'cycle-non-closure': cycleNonClosure,
  'wavelength-version-change': wavelengthVersionChange,
  'integer-multi-solution': integerMultiSolution,
  'local-lock-conflict': localLockConflict,
};

/** 组合输入：把多种缺陷叠加到同一张图上（低振幅孔洞 + 残差 + 遮罩墙）。 */
export function combinedInput(seed: number): ScenarioInput {
  const rand = mulberry32(seed);
  const g = rampPhase(0.8, 0.3);
  const quality = baseQuality();
  const mask = makeGrid(W, H, 0);
  craftResiduePlus(g, 8, 6);
  craftResidueMinus(g, 13, 9);
  craftSpike(g, 10, 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = idx(g, x, y);
      const dx = x - 4;
      const dy = y - 4;
      if (dx * dx + dy * dy <= 3) quality.data[i] = 0.04;
      else quality.data[i] = Math.min(1, quality.data[i] + (rand() - 0.5) * 0.1);
    }
  for (let y = 0; y < H; y++) mask.data[idx(mask, 12, y)] = 1;
  return { wrappedPhase: g, quality, invalidMask: mask };
}

export const GRID_WIDTH = W;
export const GRID_HEIGHT = H;
