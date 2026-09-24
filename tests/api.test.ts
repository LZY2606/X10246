import { describe, expect, it } from 'vitest';
import { handleApi } from '../src/server/api.js';
import { SCENARIO_BUILDERS } from '../src/domain/scenarios.js';
import { makeStore } from './helpers.js';

describe('API 处理器', () => {
  it('导入 → 候选 → 裁定 → 重放 → 导出/导入 全链路', () => {
    const ctx = makeStore('api');
    const { store } = ctx;
    const input = SCENARIO_BUILDERS['phase-crossing-boundary']();
    const commit = (kind: string, entityId: string, content: unknown) => {
      const r = handleApi(store, 'POST', '/inputs', { kind, entityId, content });
      expect(r.status).toBe(201);
      return r.body as any;
    };
    commit('wrapped_phase', 'a/phase', input.wrappedPhase);
    commit('quality_map', 'a/quality', input.quality);
    commit('invalid_mask', 'a/mask', input.invalidMask);
    commit('wavelength', 'a/wl', { wavelength: { value: 632.8, unit: 'nm' } });
    commit('incidence_geometry', 'a/geo', { angle: { value: 30, unit: 'deg' }, passFactor: 2, frame: 'sample-plane' });
    commit('calibration_plane', 'a/cal', { a: 0.4, b: -0.2, c: 12.5, unit: 'nm', frame: 'sample-plane' });

    const bad = handleApi(store, 'POST', '/inputs', {
      kind: 'wrapped_phase',
      entityId: 'a/bad',
      content: { width: 2, height: 2, data: [0, 1, 2] },
    });
    expect(bad.status).toBe(422);
    expect((bad.body as any).diagnostics.length).toBeGreaterThan(0);

    const uw = handleApi(store, 'POST', '/unwrap', {
      refs: {
        wrappedPhase: { entityId: 'a/phase', versionNo: 1 },
        quality: { entityId: 'a/quality', versionNo: 1 },
        invalidMask: { entityId: 'a/mask', versionNo: 1 },
      },
    });
    expect(uw.status).toBe(201);
    const candidateId = (uw.body as any).candidateIds[0];

    const h = handleApi(store, 'POST', '/height', {
      candidateResultId: candidateId,
      refs: {
        wavelength: { entityId: 'a/wl', versionNo: 1 },
        incidenceGeometry: { entityId: 'a/geo', versionNo: 1 },
        calibrationPlane: { entityId: 'a/cal', versionNo: 1 },
      },
    });
    expect(h.status).toBe(201);

    const dec = handleApi(store, 'POST', '/decisions', { resultId: candidateId, action: 'accept', reason: 'ok' });
    expect(dec.status).toBe(201);

    const detail = handleApi(store, 'GET', `/results/${candidateId}`);
    expect((detail.body as any).status).toBe('accepted');
    expect((detail.body as any).sourceRefs.length).toBe(3);

    const replay = handleApi(store, 'GET', '/replay/1');
    expect((replay.body as any).results).toHaveLength(0);

    const dump = handleApi(store, 'GET', '/export');
    expect(dump.status).toBe(200);

    const ctx2 = makeStore('api2');
    const imp = handleApi(ctx2.store, 'POST', '/import', dump.body);
    expect(imp.status).toBe(201);
    const detail2 = handleApi(ctx2.store, 'GET', `/results/${candidateId}`);
    expect(detail2.body).toEqual(detail.body);

    const missing = handleApi(store, 'GET', '/inputs/a/phase/99');
    expect(missing.status).toBe(409);
    expect((missing.body as any).error).toContain('refusing to fall back to latest');
    ctx.cleanup();
    ctx2.cleanup();
  });

  it('加载案例包端点', () => {
    const ctx = makeStore('api-case');
    const r = handleApi(ctx.store, 'POST', '/case/load');
    expect(r.status).toBe(201);
    expect((r.body as any).scenarioCoverage.length).toBe(7);
    ctx.cleanup();
  });
});
