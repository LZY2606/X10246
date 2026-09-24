import { describe, expect, it } from 'vitest';
import { CASE_DIR, loadCasePack } from '../src/server/casepack.js';
import { makeStore } from './helpers.js';

const ALL_SCENARIOS = [
  'phase-crossing-boundary',
  'low-amplitude-hole',
  'multi-connected-region',
  'cycle-non-closure',
  'wavelength-version-change',
  'integer-multi-solution',
  'local-lock-conflict',
];

describe('干涉条纹簿案例包重放', () => {
  it('重放覆盖全部七个情形并留下机器可读事件', () => {
    const ctx = makeStore('case');
    const summary = loadCasePack(ctx.store);
    for (const s of ALL_SCENARIOS) expect(summary.scenarioCoverage).toContain(s);
    const types = new Set(ctx.store.listEvents().map((e) => e.type));
    for (const t of [
      'input.committed',
      'unwrap.candidate.generated',
      'height.chain.computed',
      'result.staled',
      'decision.accept',
      'decision.reject',
      'decision.undone',
      'lock.conflict',
      'lock.conflict.resolved',
      'scenario.completed',
    ]) {
      expect(types.has(t), `missing event type ${t}`).toBe(true);
    }
    ctx.cleanup();
  });

  it('参数修订（波长版本变更）使旧高度链过期但保留旧版本引用', () => {
    const ctx = makeStore('case-wl');
    loadCasePack(ctx.store);
    const wl = ctx.store.listEntities().find((e) => e.entityId === 'book/wavelength')!;
    expect(wl.versions.map((v) => v.versionNo)).toEqual([1, 2]);
    const v1 = ctx.store.getEntityVersion('book/wavelength', 1);
    const v2 = ctx.store.getEntityVersion('book/wavelength', 2);
    expect((v1.content as any).wavelength.value).toBe(632.8);
    expect((v2.content as any).wavelength.value).toBe(635.0);
    const heights = ctx.store.listResults({ kind: 'height_map' });
    expect(heights.length).toBe(2);
    const stale = heights.find((h) => h.status === 'stale')!;
    expect(stale.sourceRefs.find((r) => r.entityId === 'book/wavelength')!.versionNo).toBe(1);
    // 从最终状态反查：哪条材料、哪版规则、哪次决定造成差异
    const staleResult = ctx.store.getResult(stale.resultId);
    expect(staleResult.content as any).toHaveProperty('steps');
    const events = ctx.store.listEvents();
    const staledEvent = events.find((e) => e.type === 'result.staled' && (e.payload as any).resultId === stale.resultId)!;
    expect((staledEvent.payload as any).because).toEqual({ entityId: 'book/wavelength', newVersion: 2 });
    ctx.cleanup();
  });

  it('局部源数据改动只使区域重叠的派生结果过期', () => {
    const ctx = makeStore('case-local');
    loadCasePack(ctx.store);
    const events = ctx.store.listEvents();
    const patchCommit = events.find(
      (e) => e.type === 'input.committed' && (e.payload as any).entityId === 'book/quality-map' && (e.payload as any).versionNo === 2,
    )!;
    expect((patchCommit.payload as any).region).toEqual({ x: 2, y: 2, width: 4, height: 4 });
    ctx.cleanup();
  });

  it('共享原始片段只存一份（最小/组合输入的相同遮罩去重）', () => {
    const ctx = makeStore('case-dedup');
    loadCasePack(ctx.store);
    const blobs = ctx.store.db.prepare(`SELECT COUNT(*) AS c FROM blobs`).get() as { c: number };
    const versions = ctx.store.db.prepare(`SELECT COUNT(*) AS c FROM input_versions`).get() as { c: number };
    expect(blobs.c).toBeLessThan(versions.c);
    ctx.cleanup();
  });

  it('锁定冲突双方保留且解决写入历史；旧事件可回放当时状态', () => {
    const ctx = makeStore('case-lock');
    loadCasePack(ctx.store);
    const locks = ctx.store.listLocks();
    expect(locks.map((l) => l.status).sort()).toEqual(['active', 'released']);
    const conflictEvent = ctx.store.listEvents().find((e) => e.type === 'lock.conflict')!;
    const before = ctx.store.stateAt(conflictEvent.seq);
    expect(before.locks.map((l) => l.status).sort()).toEqual(['active', 'conflicted']);
    const final = ctx.store.stateAt(Number.MAX_SAFE_INTEGER);
    expect(final.locks.map((l) => l.status).sort()).toEqual(['active', 'released']);
    ctx.cleanup();
  });

  it('案例包导出→删除→导入后身份与顺序保持', () => {
    const ctx = makeStore('case-exp');
    loadCasePack(ctx.store);
    const dump = ctx.store.exportDump();
    const events = ctx.store.listEvents();
    ctx.cleanup();
    const ctx2 = makeStore('case-imp');
    ctx2.store.importDump(dump);
    expect(ctx2.store.listEvents()).toEqual(events);
    ctx2.cleanup();
  });

  it('CASE_DIR 指向仓库内案例包', () => {
    expect(CASE_DIR).toContain('cases/interference-book');
  });
});
