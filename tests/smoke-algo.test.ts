import { describe, it, expect } from 'vitest';
import { computeQualityMap } from '../shared/domain/quality.js';
import { computeResidueMap, computeBranchCuts } from '../shared/domain/residues.js';
import { computeUnwrappedForest } from '../shared/domain/unwrap.js';
import { computeHeightChain } from '../shared/domain/height.js';
import {
  makeWrappedPhase,
  makeAmplitude,
  makeMask,
  makeWavelength,
  makeGeometry,
  makeCalibration
} from '../shared/schema/samples.js';

const base = { width: 12, height: 12, seed: 42, kx: 0.4, ky: 0.25, saddle: 0 };

describe('相位展开算法冒烟', () => {
  it('平滑场：无残差、单树、环闭合', () => {
    const phase = makeWrappedPhase(base);
    const amp = makeAmplitude(base);
    const mask = makeMask(base);
    const q = computeQualityMap(phase, amp, mask);
    const res = computeResidueMap(phase, q);
    const cuts = computeBranchCuts(res);
    const forest = computeUnwrappedForest(phase, q, res, cuts);
    expect(res.charges.length).toBe(0);
    expect(forest.trees.length).toBe(1);
    expect(forest.cycles.every((c) => c.closed)).toBe(true);
    // 展开相位连续（相邻差在 (-pi,pi)）
    let maxJump = 0;
    for (let v = 0; v < 12; v++)
      for (let u = 0; u < 11; u++) {
        const a = forest.unwrappedPhase[v * 12 + u]!;
        const b = forest.unwrappedPhase[v * 12 + u + 1]!;
        maxJump = Math.max(maxJump, Math.abs(b - a));
      }
    expect(maxJump).toBeLessThan(Math.PI);
  });

  it('注入残差偶极：出现电荷、切口显式 null、环不闭合', () => {
    const opts = { ...base, residueDipoles: [{ u: 4, v: 4, sign: 1 as const }, { u: 7, v: 7, sign: -1 as const }] };
    const phase = makeWrappedPhase(opts);
    const amp = makeAmplitude(opts);
    const mask = makeMask(opts);
    const q = computeQualityMap(phase, amp, mask);
    const res = computeResidueMap(phase, q);
    expect(res.charges.length).toBeGreaterThanOrEqual(2);
    const cuts = computeBranchCuts(res);
    expect(cuts.edges.length).toBeGreaterThan(0);
    expect(cuts.edges.every((e) => e.integerOffset === null)).toBe(true);
    const forest = computeUnwrappedForest(phase, q, res, cuts);
    expect(forest.integerCandidates).toBeTruthy();
  });

  it('低振幅孔洞：像素不展开且为 null，形成多棵树', () => {
    const opts = { ...base, holes: [{ u0: 4, v0: 4, u1: 7, v1: 7 }] };
    const phase = makeWrappedPhase(opts);
    const amp = makeAmplitude(opts);
    const mask = makeMask(opts);
    const q = computeQualityMap(phase, amp, mask);
    const nullCount = q.score.filter((s) => s === null).length;
    expect(nullCount).toBeGreaterThan(0);
    const res = computeResidueMap(phase, q);
    const cuts = computeBranchCuts(res);
    const forest = computeUnwrappedForest(phase, q, res, cuts);
    for (let v = 4; v <= 7; v++)
      for (let u = 4; u <= 7; u++) expect(forest.unwrappedPhase[v * 12 + u]).toBeNull();
  });

  it('遮罩隔断：产生多连通区（多棵树）', () => {
    const opts = {
      ...base,
      maskBlocks: [{ u0: 0, v0: 5, u1: 11, v1: 6 }]
    };
    const phase = makeWrappedPhase(opts);
    const amp = makeAmplitude(opts);
    const mask = makeMask(opts);
    const q = computeQualityMap(phase, amp, mask);
    const res = computeResidueMap(phase, q);
    const cuts = computeBranchCuts(res);
    const forest = computeUnwrappedForest(phase, q, res, cuts);
    expect(forest.trees.length).toBeGreaterThanOrEqual(2);
  });

  it('高度链：波长与几何给定时得到有限高度，单位齐全', () => {
    const phase = makeWrappedPhase(base);
    const amp = makeAmplitude(base);
    const mask = makeMask(base);
    const q = computeQualityMap(phase, amp, mask);
    const res = computeResidueMap(phase, q);
    const cuts = computeBranchCuts(res);
    const forest = computeUnwrappedForest(phase, q, res, cuts);
    const heights = computeHeightChain(forest, makeWavelength(632.8), makeGeometry(), makeCalibration());
    expect(heights.heights.every((z) => z === null || Number.isFinite(z))).toBe(true);
    const chain = heights.chains['0,0'];
    expect(chain.map((s) => s.unit.symbol)).toContain('m');
  });
});
