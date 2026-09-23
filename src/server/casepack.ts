// 离线案例包：干涉条纹簿 —— 相位展开、支路切口与光学标定分支
// 固定 seed、确定性生成；不访问公网，不依赖外部文件。
import { Store } from './store';
import { DEFAULT_PARAMS, runHeightDerivation, runUnwrapDerivation } from './derive';
import type { CutSegment, GridField, MaskGrid } from '../shared/domain';

export const CASEPACK_ID = 'fringe-book-2026a';
export const CASEPACK_SEED = 20260919;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAME = 'pixel@origin-top-left';

function rampField(w: number, h: number, slopeX: number, slopeY: number): GridField {
  const data: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const phi = slopeX * x + slopeY * y;
    let v = phi % (2 * Math.PI);
    if (v > Math.PI) v -= 2 * Math.PI;
    if (v <= -Math.PI) v += 2 * Math.PI;
    data.push(v);
  }
  return { width: w, height: h, unit: 'rad', frame: FRAME, data };
}

function vortexField(w: number, h: number, cx: number, cy: number): GridField {
  const data: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.push(Math.atan2(y - cy, x - cx));
  return { width: w, height: h, unit: 'rad', frame: FRAME, data };
}

function qualityField(w: number, h: number, holes: [number, number, number][], rand: () => number): GridField {
  const data: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let q = 0.85 + 0.1 * rand();
    for (const [hx, hy, r] of holes) {
      if (Math.hypot(x - hx, y - hy) <= r) q = 0.05;
    }
    data.push(q);
  }
  return { width: w, height: h, unit: 'snr-linear', frame: FRAME, data };
}

function maskField(w: number, h: number, blocks: [number, number, number, number][]): MaskGrid {
  const data = new Array(w * h).fill(0);
  for (const [bx, by, bw, bh] of blocks) {
    for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) data[y * w + x] = 1;
  }
  return { width: w, height: h, frame: FRAME, data };
}

export interface ScenarioDef {
  id: string;
  title: string;
  expectEvents: string[];
}

export const SCENARIOS: ScenarioDef[] = [
  { id: 'phase-crossing-boundary', title: '相位跨越边界', expectEvents: ['PHASE_CROSSING_BOUNDARY'] },
  { id: 'low-amplitude-hole', title: '低振幅孔洞', expectEvents: ['LOW_AMPLITUDE_NO_GUESS'] },
  { id: 'multi-connected-region', title: '多连通区', expectEvents: ['MULTI_COMPONENT_REGION'] },
  { id: 'cycle-nonclosure', title: '循环不闭合', expectEvents: ['CYCLE_NONCLOSURE'] },
  { id: 'wavelength-version-change', title: '波长版本变更', expectEvents: ['WAVELENGTH_VERSION_CHANGE'] },
  { id: 'integer-multisolution', title: '整周多解', expectEvents: ['INTEGER_AMBIGUITY'] },
  { id: 'local-lock-conflict', title: '局部锁定冲突', expectEvents: ['LOCAL_LOCK_CONFLICT'] },
];

export interface ReplayReport {
  casepackId: string;
  baselineInputIds: Record<string, string>;
  scenarioResults: { id: string; title: string; eventsFired: string[]; ok: boolean }[];
  decisionIds: string[];
  eventCount: number;
}

// 完整叙事重放：
// 1) 导入基线（七种输入实体，均不可覆盖）
// 2) 一次参数修订（波长 v1→v2）
// 3) 一次只影响局部依赖的源数据改动（信噪评分局部补丁）
// 4) 一次互相冲突的人工决定（局部锁定冲突）
// 途中逐一触发七个反例场景，最小输入与组合输入共享的原始片段只存一份。
export function replayCasePack(store: Store): ReplayReport {
  const rand = mulberry32(CASEPACK_SEED);
  const W = 12;
  const H = 12;
  const report: ReplayReport = {
    casepackId: CASEPACK_ID,
    baselineInputIds: {},
    scenarioResults: [],
    decisionIds: [],
    eventCount: 0,
  };

  // ---- 基线导入 ----
  const baselinePhase = rampField(W, H, 1.9, 0.7);
  const baselineQuality = qualityField(W, H, [], rand);
  const baselineMask = maskField(W, H, []);
  const baselineCuts: { segments: CutSegment[] } = { segments: [] };
  const wavelengthV1 = { value: 632.8, unit: 'nm' };
  const geometry = { thetaDeg: 30, unit: 'deg', frame: 'reflection@normal-reference' };
  const calibration = { a: 0.02, b: -0.01, c: 0.5, unit: 'rad/pixel', frame: FRAME };

  report.baselineInputIds.wrapped_phase = store.submitInput('wrapped_phase', baselinePhase).id;
  report.baselineInputIds.quality_score = store.submitInput('quality_score', baselineQuality).id;
  report.baselineInputIds.invalid_mask = store.submitInput('invalid_mask', baselineMask).id;
  report.baselineInputIds.cut_edit_history = store.submitInput('cut_edit_history', baselineCuts).id;
  report.baselineInputIds.wavelength = store.submitInput('wavelength', wavelengthV1).id;
  report.baselineInputIds.incidence_geometry = store.submitInput('incidence_geometry', geometry).id;
  report.baselineInputIds.calibration_plane = store.submitInput('calibration_plane', calibration).id;

  const baseDerivation = runUnwrapDerivation(store, DEFAULT_PARAMS);
  const adopted = baseDerivation.candidateIds[0];
  const d1 = store.recordDecision('accept_candidate', adopted, '基线主树候选与标定面一致，采纳');
  report.decisionIds.push(d1.id);
  runHeightDerivation(store, adopted);

  // ---- 场景 1：相位跨越边界（最小输入）----
  {
    const sPhase = rampField(6, 6, 2.4, 0.0);
    const sQuality = qualityField(6, 6, [], rand);
    const sMask = maskField(6, 6, []);
    store.submitInput('wrapped_phase', sPhase);
    store.submitInput('quality_score', sQuality);
    store.submitInput('invalid_mask', sMask);
    const der = runUnwrapDerivation(store, DEFAULT_PARAMS);
    const fired = der.eventIds.map((id) => store.getEvent(id)!.type);
    report.scenarioResults.push({
      id: 'phase-crossing-boundary', title: '相位跨越边界',
      eventsFired: fired, ok: fired.includes('PHASE_CROSSING_BOUNDARY'),
    });
  }

  // ---- 场景 2：低振幅孔洞（最小输入）----
  {
    const sPhase = rampField(6, 6, 0.5, 0.3);
    const sQuality = qualityField(6, 6, [[2, 2, 1.5]], rand);
    const sMask = maskField(6, 6, []);
    store.submitInput('wrapped_phase', sPhase);
    store.submitInput('quality_score', sQuality);
    store.submitInput('invalid_mask', sMask);
    const der = runUnwrapDerivation(store, DEFAULT_PARAMS);
    const fired = der.eventIds.map((id) => store.getEvent(id)!.type);
    report.scenarioResults.push({
      id: 'low-amplitude-hole', title: '低振幅孔洞',
      eventsFired: fired, ok: fired.includes('LOW_AMPLITUDE_NO_GUESS'),
    });
  }

  // ---- 场景 3：多连通区（最小输入：遮罩把视场劈成两块）----
  {
    const sPhase = rampField(6, 6, 0.4, 0.4);
    const sQuality = qualityField(6, 6, [], rand);
    const sMask = maskField(6, 6, [[2, 0, 1, 6]]);
    store.submitInput('wrapped_phase', sPhase);
    store.submitInput('quality_score', sQuality);
    store.submitInput('invalid_mask', sMask);
    const der = runUnwrapDerivation(store, DEFAULT_PARAMS);
    const fired = der.eventIds.map((id) => store.getEvent(id)!.type);
    report.scenarioResults.push({
      id: 'multi-connected-region', title: '多连通区',
      eventsFired: fired, ok: fired.includes('MULTI_COMPONENT_REGION'),
    });
  }

  // ---- 场景 4：循环不闭合（最小输入：涡旋相位）----
  {
    const sPhase = vortexField(6, 6, 2.5, 2.5);
    const sQuality = qualityField(6, 6, [], rand);
    const sMask = maskField(6, 6, []);
    store.submitInput('wrapped_phase', sPhase);
    store.submitInput('quality_score', sQuality);
    store.submitInput('invalid_mask', sMask);
    const der = runUnwrapDerivation(store, DEFAULT_PARAMS);
    const fired = der.eventIds.map((id) => store.getEvent(id)!.type);
    report.scenarioResults.push({
      id: 'cycle-nonclosure', title: '循环不闭合',
      eventsFired: fired, ok: fired.includes('CYCLE_NONCLOSURE'),
    });
  }

  // ---- 场景 5：波长版本变更（参数修订：632.8nm → 635.0nm）----
  {
    // 先回到基线视场，让高度链有依赖对象
    store.submitInput('wrapped_phase', baselinePhase);
    store.submitInput('quality_score', baselineQuality);
    store.submitInput('invalid_mask', baselineMask);
    const der = runUnwrapDerivation(store, DEFAULT_PARAMS);
    runHeightDerivation(store, der.candidateIds[0]);
    const before = store.events().length;
    store.submitInput('wavelength', { value: 635.0, unit: 'nm' });
    const newEvents = store.events().slice(before).map((e) => e.type);
    // 波长变更只应让高度链过期，候选不应过期
    const staleHeights = store.derivedByKind('height_map').filter((h) => h.status === 'stale').length;
    const staleCands = store.derivedByKind('unwrap_candidate').filter((c) => c.status === 'stale').length;
    report.scenarioResults.push({
      id: 'wavelength-version-change', title: '波长版本变更',
      eventsFired: newEvents,
      ok: newEvents.includes('WAVELENGTH_VERSION_CHANGE') && staleHeights > 0 && staleCands === 0,
    });
  }

  // ---- 场景 6：整周多解（组合输入：涡旋 + 切口 + 低振幅孔洞）----
  {
    const sPhase = vortexField(8, 8, 3.5, 3.5);
    const sQuality = qualityField(8, 8, [[6, 1, 1.2]], rand);
    const sMask = maskField(8, 8, []);
    const sCuts: { segments: CutSegment[] } = {
      segments: [
        { ax: 3, ay: 3, bx: 4, by: 3 },
        { ax: 4, ay: 3, bx: 5, by: 3 },
        { ax: 5, ay: 3, bx: 6, by: 3 },
      ],
    };
    store.submitInput('wrapped_phase', sPhase);
    store.submitInput('quality_score', sQuality);
    store.submitInput('invalid_mask', sMask);
    store.submitInput('cut_edit_history', sCuts);
    const der = runUnwrapDerivation(store, DEFAULT_PARAMS);
    const fired = der.eventIds.map((id) => store.getEvent(id)!.type);
    const candidateCount = der.candidateIds.length;
    report.scenarioResults.push({
      id: 'integer-multisolution', title: '整周多解',
      eventsFired: fired,
      ok: fired.includes('INTEGER_AMBIGUITY') && candidateCount >= 2 && der.ambiguityGroupId !== null,
    });

    // ---- 场景 7：局部锁定冲突（互相冲突的人工决定）----
    const [candA, candB] = der.candidateIds;
    const region = { x: 2, y: 2, width: 3, height: 3 };
    const lockA = store.recordDecision('lock_local', candA, '审阅者甲：主树解在切口北侧与标定一致', region);
    const lockB = store.recordDecision('lock_local', candB, '审阅者乙：备选整周解在局部更平滑', region);
    report.decisionIds.push(lockA.id, lockB.id);
    const conflictFired = store.events().some((e) => e.type === 'LOCAL_LOCK_CONFLICT');
    // 撤销乙的锁定，冲突解决写入历史
    const undo = store.recordDecision('undo', lockB.id, '复核：乙的锁定基于过期候选，撤销');
    report.decisionIds.push(undo.id);
    report.scenarioResults.push({
      id: 'local-lock-conflict', title: '局部锁定冲突',
      eventsFired: ['LOCAL_LOCK_CONFLICT', 'DECISION_UNDONE'],
      ok: conflictFired && store.decisions().find((d) => d.id === lockB.id)?.effective === false,
    });
  }

  // ---- 局部源数据改动：信噪评分局部补丁，只让重叠候选过期 ----
  {
    const patched = qualityField(8, 8, [[6, 1, 1.2], [1, 6, 1.5]], rand);
    store.submitInput('quality_score', patched, { x: 0, y: 5, width: 3, height: 3 });
  }

  store.recordEvent('CASEPACK_REPLAY', Object.values(report.baselineInputIds), {
    casepackId: CASEPACK_ID,
    seed: CASEPACK_SEED,
    scenarios: report.scenarioResults.map((s) => ({ id: s.id, ok: s.ok })),
  });
  report.eventCount = store.events().length;
  return report;
}
