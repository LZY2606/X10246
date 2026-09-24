import { describe, expect, it } from 'vitest';
import { SCENARIO_BUILDERS } from '../src/domain/scenarios.js';
import { CorruptionError, FormatError, ImmutableError, hashContent } from '../src/server/store.js';
import { makeStore } from './helpers.js';

function commitBaseline(store: ReturnType<typeof makeStore>['store']) {
  const input = SCENARIO_BUILDERS['phase-crossing-boundary']();
  const phase = store.commitInput({ kind: 'wrapped_phase', entityId: 't/phase', content: input.wrappedPhase });
  const quality = store.commitInput({ kind: 'quality_map', entityId: 't/quality', content: input.quality });
  const mask = store.commitInput({ kind: 'invalid_mask', entityId: 't/mask', content: input.invalidMask });
  return { input, phase, quality, mask };
}

describe('不可变输入', () => {
  it('相同内容重复提交被拒绝；修订以新版本+父版本表达', () => {
    const ctx = makeStore('immut');
    const { store } = ctx;
    const input = SCENARIO_BUILDERS['wavelength-version-change']();
    store.commitInput({ kind: 'wavelength', entityId: 't/wl', content: { wavelength: { value: 632.8, unit: 'nm' } } });
    expect(() =>
      store.commitInput({ kind: 'wavelength', entityId: 't/wl', content: { wavelength: { value: 632.8, unit: 'nm' } } }),
    ).toThrow(ImmutableError);
    const v2 = store.commitInput({ kind: 'wavelength', entityId: 't/wl', content: { wavelength: { value: 635.0, unit: 'nm' } } });
    expect(v2.versionNo).toBe(2);
    expect(v2.parentVersionNo).toBe(1);
    const v1 = store.getEntityVersion('t/wl', 1);
    expect((v1.content as any).wavelength.value).toBe(632.8);
    ctx.cleanup();
  });

  it('最小输入与组合输入共享的原始片段只存一份', () => {
    const ctx = makeStore('dedup');
    const { store } = ctx;
    const input = SCENARIO_BUILDERS['phase-crossing-boundary']();
    store.commitInput({ kind: 'invalid_mask', entityId: 'a/mask', content: input.invalidMask });
    store.commitInput({ kind: 'invalid_mask', entityId: 'b/mask', content: input.invalidMask });
    const blobs = store.db.prepare(`SELECT COUNT(*) AS c FROM blobs`).get() as { c: number };
    expect(blobs.c).toBe(1);
    ctx.cleanup();
  });

  it('格式错误被明确拒绝并给出诊断', () => {
    const ctx = makeStore('fmt');
    const { store } = ctx;
    expect(() =>
      store.commitInput({ kind: 'wrapped_phase', content: { width: 2, height: 2, data: [0, 1, 2] } }),
    ).toThrow(FormatError);
    try {
      store.commitInput({ kind: 'quality_map', content: { width: 1, height: 1, data: [7] } });
    } catch (e) {
      expect((e as FormatError).diagnostics[0]).toContain('out of allowed range');
    }
    ctx.cleanup();
  });
});

describe('派生与过期', () => {
  it('局部源数据改动只使区域重叠的派生结果过期；过期结果仍可查看', () => {
    const ctx = makeStore('stale');
    const { store } = ctx;
    const { input } = commitBaseline(store);
    const region = { x: 0, y: 0, width: 8, height: 12 };
    const far = store.runUnwrap({
      refs: {
        wrappedPhase: { entityId: 't/phase', versionNo: 1 },
        quality: { entityId: 't/quality', versionNo: 1 },
        invalidMask: { entityId: 't/mask', versionNo: 1 },
      },
      params: { region: { x: 8, y: 0, width: 8, height: 12 } },
    });
    const near = store.runUnwrap({
      refs: {
        wrappedPhase: { entityId: 't/phase', versionNo: 1 },
        quality: { entityId: 't/quality', versionNo: 1 },
        invalidMask: { entityId: 't/mask', versionNo: 1 },
      },
      params: { region },
    });
    const patched = { ...input.quality, data: [...input.quality.data] };
    patched.data[0] = 0.1;
    const commit = store.commitInput({
      kind: 'quality_map',
      entityId: 't/quality',
      content: patched,
      meta: { region },
    });
    expect(commit.staleResultIds.sort()).toEqual([...near.candidateIds].sort());
    expect(store.getResult(far.candidateIds[0]).status).toBe('current');
    const stale = store.getResult(near.candidateIds[0]);
    expect(stale.status).toBe('stale');
    expect(stale.content).toBeTruthy(); // 过期结果仍可查看，但不能冒充当前
    ctx.cleanup();
  });

  it('波长版本变更使高度链过期，旧结果保留旧版本引用', () => {
    const ctx = makeStore('wl');
    const { store } = ctx;
    commitBaseline(store);
    store.commitInput({ kind: 'wavelength', entityId: 't/wl', content: { wavelength: { value: 632.8, unit: 'nm' } } });
    store.commitInput({
      kind: 'incidence_geometry',
      entityId: 't/geo',
      content: { angle: { value: 30, unit: 'deg' }, passFactor: 2, frame: 'sample-plane' },
    });
    store.commitInput({
      kind: 'calibration_plane',
      entityId: 't/cal',
      content: { a: 0.4, b: -0.2, c: 12.5, unit: 'nm', frame: 'sample-plane' },
    });
    const { candidateIds } = store.runUnwrap({
      refs: {
        wrappedPhase: { entityId: 't/phase', versionNo: 1 },
        quality: { entityId: 't/quality', versionNo: 1 },
        invalidMask: { entityId: 't/mask', versionNo: 1 },
      },
    });
    const height = store.runHeight({
      candidateResultId: candidateIds[0],
      refs: {
        wavelength: { entityId: 't/wl', versionNo: 1 },
        incidenceGeometry: { entityId: 't/geo', versionNo: 1 },
        calibrationPlane: { entityId: 't/cal', versionNo: 1 },
      },
    });
    store.commitInput({ kind: 'wavelength', entityId: 't/wl', content: { wavelength: { value: 635.0, unit: 'nm' } } });
    const staleHeight = store.getResult(height.resultId);
    expect(staleHeight.status).toBe('stale');
    const wlRef = staleHeight.sourceRefs.find((r) => r.entityId === 't/wl');
    expect(wlRef?.versionNo).toBe(1); // 旧结果仍指向旧波长版本
    const wl1 = store.getEntityVersion('t/wl', 1);
    expect((wl1.content as any).wavelength.value).toBe(632.8);
    ctx.cleanup();
  });
});

describe('损坏检测', () => {
  it('缺少引用必须报损坏，不能退回当前最新版', () => {
    const ctx = makeStore('corrupt');
    const { store } = ctx;
    commitBaseline(store);
    const { candidateIds } = store.runUnwrap({
      refs: {
        wrappedPhase: { entityId: 't/phase', versionNo: 1 },
        quality: { entityId: 't/quality', versionNo: 1 },
        invalidMask: { entityId: 't/mask', versionNo: 1 },
      },
    });
    store.commitInput({
      kind: 'wrapped_phase',
      entityId: 't/phase',
      content: SCENARIO_BUILDERS['low-amplitude-hole']().wrappedPhase,
    });
    store.db.prepare(`DELETE FROM input_versions WHERE entity_id = 't/phase' AND version_no = 1`).run();
    expect(() => store.getEntityVersion('t/phase', 1)).toThrow(CorruptionError);
    expect(() => store.getResult(candidateIds[0])).toThrow(CorruptionError);
    // 最新版仍在，但绝不悄悄退回
    expect(store.getEntityVersion('t/phase').versionNo).toBe(2);
    ctx.cleanup();
  });

  it('查询实体返回版本号与内容摘要', () => {
    const ctx = makeStore('digest');
    const { store } = ctx;
    const input = SCENARIO_BUILDERS['phase-crossing-boundary']();
    store.commitInput({ kind: 'wrapped_phase', entityId: 't/phase', content: input.wrappedPhase });
    const v = store.getEntityVersion('t/phase', 1);
    expect(v.digest).toBe(`sha256:${hashContent(input.wrappedPhase)}`);
    ctx.cleanup();
  });
});

describe('局部锁定冲突', () => {
  it('重叠区域整周偏移不同的锁定显式冲突，解决与撤销写入历史', () => {
    const ctx = makeStore('lock');
    const { store } = ctx;
    const input = SCENARIO_BUILDERS['local-lock-conflict']();
    store.commitInput({ kind: 'wrapped_phase', entityId: 't/phase', content: input.wrappedPhase });
    store.commitInput({ kind: 'quality_map', entityId: 't/quality', content: input.quality });
    store.commitInput({ kind: 'invalid_mask', entityId: 't/mask', content: input.invalidMask });
    const { candidateIds } = store.runUnwrap({
      refs: {
        wrappedPhase: { entityId: 't/phase', versionNo: 1 },
        quality: { entityId: 't/quality', versionNo: 1 },
        invalidMask: { entityId: 't/mask', versionNo: 1 },
      },
    });
    const a = store.lockLocal({
      resultId: candidateIds[0],
      region: { x: 4, y: 4, width: 6, height: 4 },
      kOffsets: { 'component:0': 0 },
    });
    expect(a.conflict).toBe(false);
    const b = store.lockLocal({
      resultId: candidateIds[0],
      region: { x: 6, y: 4, width: 4, height: 4 },
      kOffsets: { 'component:0': 1 },
    });
    expect(b.conflict).toBe(true);
    expect(store.listLocks().map((l) => l.status).sort()).toEqual(['active', 'conflicted']);
    store.resolveLockConflict({ keepLockId: b.lockId, dropLockId: a.lockId, reason: '复测支持 +1' });
    const locks = store.listLocks();
    expect(locks.find((l) => l.lockId === b.lockId)?.status).toBe('active');
    expect(locks.find((l) => l.lockId === a.lockId)?.status).toBe('released');
    const types = store.listEvents().map((e) => e.type);
    expect(types).toContain('lock.conflict');
    expect(types).toContain('lock.conflict.resolved');
    ctx.cleanup();
  });
});

describe('决定与撤销', () => {
  it('接受/否定/撤销都生成事件，状态历史可回放', () => {
    const ctx = makeStore('decide');
    const { store } = ctx;
    commitBaseline(store);
    const { candidateIds } = store.runUnwrap({
      refs: {
        wrappedPhase: { entityId: 't/phase', versionNo: 1 },
        quality: { entityId: 't/quality', versionNo: 1 },
        invalidMask: { entityId: 't/mask', versionNo: 1 },
      },
    });
    const d = store.decide({ resultId: candidateIds[0], action: 'accept', reason: '残差为零' });
    expect(store.getResult(candidateIds[0]).status).toBe('accepted');
    const acceptSeq = store.listEvents().find((e) => e.type === 'decision.accept')!.seq;
    expect(store.stateAt(acceptSeq).results.find((r) => r.resultId === candidateIds[0])?.status).toBe('accepted');
    expect(store.stateAt(acceptSeq - 1).results.find((r) => r.resultId === candidateIds[0])?.status).toBe('current');
    store.undoDecision(d.decisionId);
    expect(store.getResult(candidateIds[0]).status).toBe('current');
    expect(store.listEvents().map((e) => e.type)).toContain('decision.undone');
    ctx.cleanup();
  });
});
