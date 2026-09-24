import { describe, expect, it } from 'vitest';
import { SCENARIO_BUILDERS, combinedInput } from '../src/domain/scenarios.js';
import {
  DEFAULT_UNWRAP_PARAMS,
  computeResidues,
  generateCandidates,
  unwrapCandidate,
} from '../src/domain/unwrap.js';
import { TEST_SEED } from './helpers.js';

const validOf = (input: ReturnType<(typeof SCENARIO_BUILDERS)[keyof typeof SCENARIO_BUILDERS]>) =>
  input.wrappedPhase.data.map(
    (_, i) => input.invalidMask.data[i] === 0 && input.quality.data[i] >= DEFAULT_UNWRAP_PARAMS.qualityThreshold,
  );

describe('相位跨越边界', () => {
  it('斜坡相位多次跨越 ±π，展开恢复整周阶梯且环路闭合', () => {
    const input = SCENARIO_BUILDERS['phase-crossing-boundary']();
    const c = unwrapCandidate(input, DEFAULT_UNWRAP_PARAMS);
    const ks = c.k.filter((v): v is number => v !== null);
    expect(Math.max(...ks) - Math.min(...ks)).toBeGreaterThanOrEqual(2);
    expect(c.consistent).toBe(true);
    expect(c.cycles).toHaveLength(0);
    expect(c.unknownCells).toHaveLength(0);
  });
});

describe('低振幅孔洞', () => {
  it('低信噪区域保持 unknown，绝不猜相位', () => {
    const input = SCENARIO_BUILDERS['low-amplitude-hole']();
    const c = unwrapCandidate(input, DEFAULT_UNWRAP_PARAMS);
    expect(c.unknownCells.length).toBeGreaterThan(0);
    for (const i of c.unknownCells) {
      expect(c.unwrapped[i]).toBeNull();
      expect(c.k[i]).toBeNull();
    }
    // 孔洞外的像素正常展开
    expect(c.unwrapped.filter((v) => v !== null).length).toBeGreaterThan(0);
  });
});

describe('多连通区', () => {
  it('遮罩墙把有效区分成两个独立分量，各自独立整周基准', () => {
    const input = SCENARIO_BUILDERS['multi-connected-region']();
    const c = unwrapCandidate(input, DEFAULT_UNWRAP_PARAMS);
    expect(c.componentCount).toBe(2);
    const comps = new Set(c.componentOf.filter((v) => v !== null));
    expect(comps.size).toBe(2);
  });
});

describe('循环不闭合', () => {
  it('检测到正负残差与不可配对尖峰；展开后非零环路残差被记录', () => {
    const input = SCENARIO_BUILDERS['cycle-non-closure']();
    const residues = computeResidues(input, validOf(input));
    expect(residues.length).toBeGreaterThanOrEqual(2);
    expect(residues.some((r) => r.residue > 0)).toBe(true);
    expect(residues.some((r) => r.residue < 0)).toBe(true);
    const c = unwrapCandidate(input, DEFAULT_UNWRAP_PARAMS);
    expect(c.cuts.length).toBeGreaterThan(0);
    // 不可配对残差 → 展开后仍有非零环路残差，候选标记不一致
    expect(c.cycles.length).toBeGreaterThan(0);
    expect(c.consistent).toBe(false);
  });
});

describe('整周多解', () => {
  it('多棵展开树产生多个局部一致候选，全部保留且路径指纹不同', () => {
    const input = SCENARIO_BUILDERS['integer-multi-solution']();
    const candidates = generateCandidates(input, DEFAULT_UNWRAP_PARAMS);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    const hashes = new Set(candidates.map((c) => c.pathHash));
    expect(hashes.size).toBeGreaterThanOrEqual(2);
    // 每个候选都携带显式切口整周偏移
    for (const c of candidates) {
      expect(c.cuts.length).toBeGreaterThan(0);
      for (const cut of c.cuts) expect(Number.isInteger(cut.kOffset)).toBe(true);
    }
  });
});

describe('组合输入', () => {
  it('固定 seed 下结果确定：孔洞 unknown + 多分量 + 残差同时成立', () => {
    const a = unwrapCandidate(combinedInput(TEST_SEED), DEFAULT_UNWRAP_PARAMS);
    const b = unwrapCandidate(combinedInput(TEST_SEED), DEFAULT_UNWRAP_PARAMS);
    expect(a.pathHash).toBe(b.pathHash);
    expect(a.unknownCells.length).toBeGreaterThan(0);
    expect(a.componentCount).toBeGreaterThanOrEqual(2);
    expect(a.cuts.length).toBeGreaterThan(0);
  });
});
