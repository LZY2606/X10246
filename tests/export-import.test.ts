import { describe, expect, it } from 'vitest';
import { SCENARIO_BUILDERS } from '../src/domain/scenarios.js';
import { CorruptionError, ImmutableError, Store } from '../src/server/store.js';
import { makeStore } from './helpers.js';

function buildState(store: Store) {
  const input = SCENARIO_BUILDERS['cycle-non-closure']();
  store.commitInput({ kind: 'wrapped_phase', entityId: 'x/phase', content: input.wrappedPhase });
  store.commitInput({ kind: 'quality_map', entityId: 'x/quality', content: input.quality });
  store.commitInput({ kind: 'invalid_mask', entityId: 'x/mask', content: input.invalidMask });
  store.commitInput({ kind: 'wavelength', entityId: 'x/wl', content: { wavelength: { value: 632.8, unit: 'nm' } } });
  store.commitInput({
    kind: 'incidence_geometry',
    entityId: 'x/geo',
    content: { angle: { value: 30, unit: 'deg' }, passFactor: 2, frame: 'sample-plane' },
  });
  store.commitInput({
    kind: 'calibration_plane',
    entityId: 'x/cal',
    content: { a: 0.4, b: -0.2, c: 12.5, unit: 'nm', frame: 'sample-plane' },
  });
  const { candidateIds } = store.runUnwrap({
    refs: {
      wrappedPhase: { entityId: 'x/phase', versionNo: 1 },
      quality: { entityId: 'x/quality', versionNo: 1 },
      invalidMask: { entityId: 'x/mask', versionNo: 1 },
    },
  });
  store.runHeight({
    candidateResultId: candidateIds[0],
    refs: {
      wavelength: { entityId: 'x/wl', versionNo: 1 },
      incidenceGeometry: { entityId: 'x/geo', versionNo: 1 },
      calibrationPlane: { entityId: 'x/cal', versionNo: 1 },
    },
  });
  store.decide({ resultId: candidateIds[0], action: 'accept', reason: '残差已配对' });
  store.lockLocal({
    resultId: candidateIds[0],
    region: { x: 2, y: 2, width: 4, height: 4 },
    kOffsets: { 'component:0': 0 },
  });
  store.commitInput({ kind: 'wavelength', entityId: 'x/wl', content: { wavelength: { value: 635.0, unit: 'nm' } } });
  return { candidateIds };
}

describe('导出 / 删除 / 导入', () => {
  it('身份、顺序与来源关系在往返后保持', () => {
    const a = makeStore('exp-a');
    buildState(a.store);
    const dump = a.store.exportDump();
    const beforeEvents = a.store.listEvents();
    const beforeResults = a.store.listResults();
    const beforeEntities = a.store.listEntities();
    const beforeLocks = a.store.listLocks();
    const beforeResult = a.store.getResult(beforeResults[0].resultId);
    a.cleanup(); // 删除本地数据库

    const b = makeStore('exp-b');
    const imported = b.store.importDump(dump);
    expect(imported.imported.events).toBe(beforeEvents.length);
    expect(b.store.listEvents()).toEqual(beforeEvents);
    expect(b.store.listResults()).toEqual(beforeResults);
    expect(b.store.listEntities()).toEqual(beforeEntities);
    expect(b.store.listLocks()).toEqual(beforeLocks);
    const afterResult = b.store.getResult(beforeResults[0].resultId);
    expect(afterResult).toEqual(beforeResult);
    // 事件顺序保持
    const seqs = b.store.listEvents().map((e) => e.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    // 导入后仍可继续工作（seq 接续）
    const c = b.store.commitInput({
      kind: 'cut_edit_history',
      entityId: 'x/cuts',
      content: { edits: [{ x: 3, y: 3, dir: 'h', action: 'add', kOffset: 1 }] },
    });
    expect(c.versionNo).toBe(1);
    b.cleanup();
  });

  it('拒绝导入到非空库；篡改内容报损坏', () => {
    const a = makeStore('exp-c');
    buildState(a.store);
    const dump = a.store.exportDump();
    expect(() => a.store.importDump(dump)).toThrow(ImmutableError);
    const tampered = JSON.parse(JSON.stringify(dump));
    tampered.tables.blobs[0].content = tampered.tables.blobs[0].content.replace('0.9', '0.8');
    const b = makeStore('exp-d');
    expect(() => b.store.importDump(tampered)).toThrow(CorruptionError);
    a.cleanup();
    b.cleanup();
  });

  it('虚拟时间下导出内容确定（固定 seed 可复现）', () => {
    const ctx1 = makeStore('det-1');
    const ctx2 = makeStore('det-2');
    buildState(ctx1.store);
    buildState(ctx2.store);
    expect(ctx1.store.exportDump()).toEqual(ctx2.store.exportDump());
    ctx1.cleanup();
    ctx2.cleanup();
  });
});

