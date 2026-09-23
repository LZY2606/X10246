/**
 * 确定性合成干涉样例（固定 seed，不访问公网）。
 * 七种情形：相位跨越边界 / 低振幅孔洞 / 多连通区 / 循环不闭合 /
 *          波长版本变更 / 整周多解 / 局部锁定冲突。
 *
 * 每个情形提供最小输入 min 与组合输入 combined；二者共享的原始片段
 * 只生成一份（内容寻址，ID 相同）。
 */
import { bits, f64, makeFragment, wrapToPi, type GridFragment } from "./grid";

export const GRID_W = 12;
export const GRID_H = 10;

export type ScenarioKey =
  | "phase-boundary-crossing"
  | "low-amplitude-hole"
  | "multiply-connected-region"
  | "cycle-not-closed"
  | "wavelength-version-changed"
  | "integer-multiple-solutions"
  | "local-lock-conflict";

/** 可复现 LCG（固定 seed）。 */
export function seededRng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function rampPhase(r: number, c: number): number {
  // 斜率刻意跨越 +/-pi 主值边界。
  return wrapToPi(-2.8 + 0.45 * c + 0.12 * r);
}

export interface RawFields {
  phase: GridFragment;
  amplitude: GridFragment;
  snr: GridFragment;
  valid: GridFragment;
}

export interface ScenarioRawPair {
  key: ScenarioKey;
  title: string;
  min: RawFields;
  combined: RawFields;
}

function baseFields(seed: number, mutate?: (b: {
  phase: number[];
  amp: number[];
  snr: number[];
  valid: string;
}) => void): RawFields {
  const rng = seededRng(seed);
  const phase: number[] = new Array(GRID_W * GRID_H);
  const amp: number[] = new Array(GRID_W * GRID_H);
  const snr: number[] = new Array(GRID_W * GRID_H);
  let valid = "";
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      const i = r * GRID_W + c;
      phase[i] = rampPhase(r, c);
      amp[i] = 120 + Math.round(6 * rng());
      snr[i] = Number((0.72 + 0.2 * rng()).toFixed(4));
      valid += "1";
    }
  }
  mutate?.({ phase, amp, snr, valid });
  return {
    phase: makeFragment("f64", GRID_W, GRID_H, phase),
    amplitude: makeFragment("f64", GRID_W, GRID_H, amp),
    snr: makeFragment("f64", GRID_W, GRID_H, snr),
    valid: makeFragment("bits", GRID_W, GRID_H, valid),
  };
}

/** 从完整遮罩字符串（逐行）重建。 */
function validFromString(s: string): GridFragment {
  return makeFragment("bits", GRID_W, GRID_H, s);
}

function vortexChargeOne(phase: number[]) {
  // 在 (r=5,c=6) 放置 +1 残荷：四个象限给出严格 +2pi 环绕。
  const phases = [0.25, 1.75 * Math.PI, -1.75 * Math.PI, -0.25];
  const cells: Array<[number, number]> = [
    [4, 5],
    [4, 6],
    [5, 5],
    [5, 6],
  ];
  cells.forEach(([r, c], k) => {
    phase[r * GRID_W + c] = wrapToPi(phases[k] as number);
  });
}

function ringMask(): string {
  // 绕 (5,6) 的 4x4 像素环置无效，内部 2x2 仍有效 → 多连通。
  let s = "";
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      const onRing =
        (r === 3 || r === 6) && c >= 4 && c <= 7 || (c === 4 || c === 7) && r >= 3 && r <= 6;
      const inside = r >= 4 && r <= 5 && c >= 5 && c <= 6;
      s += onRing && !inside ? "0" : "1";
    }
  }
  return s;
}

export function buildScenario(key: ScenarioKey): ScenarioRawPair {
  const seed = 12170000 + key.length * 917 + key.charCodeAt(0);
  switch (key) {
    case "phase-boundary-crossing": {
      const min = baseFields(seed);
      const combined = baseFields(seed, (b) => {
        // 组合：边界跨越 + 轻微噪声（固定）。
        const rng = seededRng(seed + 11);
        for (let i = 0; i < b.phase.length; i++) {
          b.phase[i] = wrapToPi(b.phase[i] as number + 0.03 * Math.sin(i * 1.7) + 0.01 * rng());
        }
      });
      return { key, title: "相位跨越边界", min, combined };
    }
    case "low-amplitude-hole": {
      const min = baseFields(seed, (b) => {
        const i = 5 * GRID_W + 6;
        b.amp[i] = 6;
        b.snr[i] = 0.02;
        b.valid = b.valid.substring(0, i) + "0" + b.valid.substring(i + 1);
      });
      const combined = baseFields(seed, (b) => {
        for (const [r, c] of [[4, 5], [4, 6], [5, 6], [6, 5], [6, 6]] as Array<[number, number]>) {
          const i = r * GRID_W + c;
          b.amp[i] = 5 + ((r + c) % 3);
          b.snr[i] = 0.01;
          b.valid = b.valid.substring(0, i) + "0" + b.valid.substring(i + 1);
        }
        const rng = seededRng(seed + 17);
        for (let i = 0; i < b.phase.length; i++) b.phase[i] = wrapToPi(b.phase[i] as number + 0.02 * rng());
      });
      return { key, title: "低振幅孔洞", min, combined };
    }
    case "multiply-connected-region": {
      const min = baseFields(seed, (b) => {
        vortexChargeOne(b.phase);
        b.valid = ringMask();
      });
      const combined = baseFields(seed, (b) => {
        vortexChargeOne(b.phase);
        b.valid = ringMask();
        // 再加一个低振幅无效点，形成第二个空洞。
        const i = 2 * GRID_W + 9;
        b.amp[i] = 4;
        b.snr[i] = 0.0;
        b.valid = b.valid.substring(0, i) + "0" + b.valid.substring(i + 1);
      });
      return { key, title: "多连通区", min, combined };
    }
    case "cycle-not-closed": {
      const min = baseFields(seed, (b) => {
        vortexChargeOne(b.phase);
        // 环周围全部有效：存在 +1 残荷，若强行生成树外闭合环则残差 2pi。
      });
      const combined = baseFields(seed, (b) => {
        vortexChargeOne(b.phase);
        const i = 8 * GRID_W + 2;
        b.amp[i] = 7;
        b.snr[i] = 0.03;
        b.valid = b.valid.substring(0, i) + "0" + b.valid.substring(i + 1);
      });
      return { key, title: "循环不闭合", min, combined };
    }
    case "wavelength-version-changed": {
      const min = baseFields(seed);
      const combined = baseFields(seed, (b) => {
        const rng = seededRng(seed + 23);
        for (let i = 0; i < b.phase.length; i++) b.phase[i] = wrapToPi(b.phase[i] as number + 0.015 * rng());
      });
      return { key, title: "波长版本变更", min, combined };
    }
    case "integer-multiple-solutions": {
      const min = baseFields(seed, (b) => {
        // 中心一条垂直“切口”两侧振幅与信噪比低，整周数无法由数据唯一决定。
        for (let r = 3; r <= 6; r++) {
          for (const c of [5, 6]) {
            const i = r * GRID_W + c;
            b.amp[i] = 18;
            b.snr[i] = 0.12;
          }
        }
      });
      const combined = baseFields(seed, (b) => {
        for (let r = 3; r <= 6; r++) for (const c of [5, 6]) {
          const i = r * GRID_W + c;
          b.amp[i] = 16;
          b.snr[i] = 0.1;
        }
        vortexChargeOne(b.phase);
      });
      return { key, title: "整周多解", min, combined };
    }
    case "local-lock-conflict": {
      const min = baseFields(seed, (b) => {
        const i = 5 * GRID_W + 6;
        b.amp[i] = 12;
        b.snr[i] = 0.08;
      });
      const combined = baseFields(seed, (b) => {
        for (const [r, c] of [[5, 6], [5, 7]] as Array<[number, number]>) {
          const i = r * GRID_W + c;
          b.amp[i] = 11;
          b.snr[i] = 0.07;
        }
      });
      return { key, title: "局部锁定冲突", min, combined };
    }
  }
}

export const ALL_SCENARIOS: ScenarioKey[] = [
  "phase-boundary-crossing",
  "low-amplitude-hole",
  "multiply-connected-region",
  "cycle-not-closed",
  "wavelength-version-changed",
  "integer-multiple-solutions",
  "local-lock-conflict",
];

export function baselineFields(): RawFields {
  return baseFields(424242);
}

export { validFromString };
