/**
 * 反例档案共享原语：七个情形共用的原始片段只生成一次（不可变内容）。
 * 最小输入与组合输入引用同一 fragment 内容（内容寻址）。
 */
import {
  CASE_COLS,
  CASE_ROWS,
  buildBundle,
  constantField,
  smoothTilt,
  stampRegion,
  vortexDipole,
} from '../src/core/synth.js';
import { wrap, TWO_PI } from '../src/core/wrap.js';

export const R = CASE_ROWS;
export const C = CASE_COLS;
export const N = R * C;

export function baseLayers() {
  const phase = smoothTilt(R, C, 0.15);
  const amplitude = constantField(1, N);
  const mask = new Array<boolean>(N).fill(false);
  const snr = constantField(0.95, N);
  return { phase, amplitude, mask, snr };
}

/** 相位跨越边界：让相邻列跨过 ±pi 包裹缝 */
export function crossingBoundaryLayers() {
  const s = baseLayers();
  // 强斜率使每几列跨越一次包裹边界
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) s.phase[r * C + c] = 0.9 * c;
  return s;
}

/** 低振幅孔洞：中央低振幅区域（不是遮罩），不得猜相位 */
export function lowAmpHoleLayers() {
  const s = baseLayers();
  stampRegion(s.mask, s.amplitude, s.snr, { r0: 6, c0: 6, r1: 9, c1: 9 }, 'low-amp');
  return s;
}

/** 多连通区：遮罩环把内部分成被包围的独立分量 */
export function multiplyConnectedLayers() {
  const s = baseLayers();
  // 用遮罩画一个矩形环，内部中心块成为被包围分量
  for (let r = 5; r <= 10; r++) {
    for (let c = 5; c <= 10; c++) {
      const onRing = r === 5 || r === 10 || c === 5 || c === 10;
      if (onRing) {
        const i = r * C + c;
        s.mask[i] = true;
        s.amplitude[i] = 0;
        s.snr[i] = 0;
      }
    }
  }
  // 内部分量带不同的整周偏置（模拟未知锚点）
  for (let r = 6; r <= 9; r++) for (let c = 6; c <= 9; c++) s.phase[r * C + c] += TWO_PI;
  return s;
}

/** 循环不闭合：注入涡旋偶极子（+/- 残差），它们之间必须有支路切口 */
export function unclosedCycleLayers() {
  const phase = vortexDipole(R, C, [5, 5], [5, 10], 0.15);
  const amplitude = constantField(1, N);
  const mask = new Array<boolean>(N).fill(false);
  const snr = constantField(0.95, N);
  return { phase, amplitude, mask, snr };
}

/** 整周多解：一条把场切成两半的人工支路（相位缝），两侧整周未知 */
export function integerMultiplicityLayers() {
  const s = baseLayers();
  // 右半边整体抬高一个整周：数据上两侧都局部一致，跨缝整周不唯一
  for (let r = 0; r < R; r++) for (let c = 8; c < C; c++) s.phase[r * C + c] += TWO_PI;
  return s;
}

/** 波长版本变更用的只是参数修订，沿用基础场 */
export function wavelengthChangeLayers() {
  return baseLayers();
}

/** 局部锁定冲突用基础场（同一像素两个互相冲突的锁定） */
export function lockConflictLayers() {
  return baseLayers();
}

export function toImport(sourceId: string, label: string, layers: ReturnType<typeof baseLayers>, createdAtVirtual: number) {
  return buildBundle({
    sourceId,
    label,
    rows: R,
    cols: C,
    phase: layers.phase,
    amplitude: layers.amplitude,
    mask: layers.mask,
    snr: layers.snr,
    createdAtVirtual,
  });
}

export { wrap, TWO_PI };
