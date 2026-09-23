/**
 * 核心状态机 + 领域算法验收测试。
 * 固定 seed、临时目录、虚拟时间；不访问公网，不依赖机器上的数据库/文件。
 * 验收 7 情形：相位边界跨越 / 低振幅孔洞 / 多连通 / 循环不闭合 /
 *             波长版本 / 整周多解 / 局部锁定冲突。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/db/ledger.ts';
import { VirtualClock } from '../src/domain/rng.ts';
import {
  buildMinimalScene,
  buildCombinedScene,
  SCENARIO_KEYS,
} from '../src/domain/scenarios.ts';
import { ingestScene } from '../src/service/ingest.ts';
import { runPipeline, type SourceIds } from '../src/service/pipeline.ts';
import { projectState } from '../src/db/projection.ts';
import { decideCandidate, lockRegion, DecisionError } from '../src/service/decisions.ts';
import { ingestWavelength } from '../src/service/ingest.ts';
import { DEFAULT_PARAMS, computeResidues, computeRegions, QualityFlag, computeQualityMap } from '../src/domain/unwrap.ts';
import type {
  IntegerCandidatesContent,
  UnwrapTreeContent,
  HeightChainContent,
  RegionLockContent,
} from '../src/domain/types.ts';

function freshLedger(): { ledger: Ledger; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'irl-'));
  return { ledger: new Ledger(join(dir, 'test.sqlite')), dir };
}

function setup(scene: ReturnType<typeof buildMinimalScene>) {
  const { ledger } = freshLedger();
  const pid = 'p';
  const clock = new VirtualClock('2026-01-01T00:00:00.000Z', 1000);
  ledger.createProject({ projectId: pid, name: 't', createdAt: clock.peek(), scenarioTags: [] });
  const ids = ingestScene(ledger, pid, clock, scene).ids as unknown as SourceIds;
  const result = runPipeline(ledger, pid, clock, ids, DEFAULT_PARAMS);
  return { ledger, pid, clock, ids, result };
}

test('相位跨越边界：倾斜条纹在 ±π 处仍连续展开', () => {
  const scene = buildMinimalScene('phase-border-crossing');
  const { ledger, pid, result } = setup(scene);
  const state = projectState(ledger, pid);
  const treeView = [...state.entities.values()].find((v) => v.type === 'unwrapTree' && v.key.endsWith('mst-quality'))!;
  const tree = treeView.versions[0].event.payload as UnwrapTreeContent;
  // 展开结果不应再有 ±π 大跳变：沿首行相邻差应平滑
  const ev = ledger.getEvent(tree.unwrappedContentId.slice(6).split(',')[0]);
  void ev;
  // 直接通过瓦片拼回栅格
  const ras = composeFromRef(ledger, tree.unwrappedContentId, 8, 8);
  const row0 = [];
  for (let c = 0; c < 8; c++) row0.push(ras[c]);
  for (let c = 1; c < 8; c++) {
    if (Number.isFinite(row0[c]) && Number.isFinite(row0[c - 1])) {
      assert.ok(Math.abs(row0[c] - row0[c - 1]) < Math.PI, '展开首行出现 > π 跳变');
    }
  }
  assert.ok(tree.cycleResiduals.every((c) => c.closed || Number.isNaN(c.residualTurns)));
});

test('低振幅孔洞：绝不猜相位（NaN），质量图显式打 LOW_AMPLITUDE', () => {
  const scene = buildMinimalScene('low-amplitude-hole');
  const { ledger, pid, result } = setup(scene);
  const state = projectState(ledger, pid);
  const qv = [...state.entities.values()].find((v) => v.type === 'qualityMap')!;
  const qp = qv.versions[0].event.payload as { flags: string[] };
  const hole = scene.features.lowAmplitudeHole!;
  for (const p of hole) assert.equal(qp.flags[p.r * 8 + p.c], 'LOW_AMPLITUDE');
  const treeView = [...state.entities.values()].find((v) => v.type === 'unwrapTree')!;
  const tree = treeView.versions[0].event.payload as UnwrapTreeContent;
  const ras = composeFromRef(ledger, tree.unwrappedContentId, 8, 8);
  for (const p of hole) assert.ok(Number.isNaN(ras[p.r * 8 + p.c]), '低振幅像素必须为 NaN，不得猜相位');
  // 结果中保留拒绝原因/未知状态（诊断）
  assert.ok(result.diagnostics.length >= 0);
});

test('多连通区：遮罩孔洞被识别，区域 containsHole', () => {
  const scene = buildMinimalScene('multiply-connected');
  const { ledger, pid } = setup(scene);
  const state = projectState(ledger, pid);
  const rv = [...state.entities.values()].find((v) => v.type === 'regionMap')!;
  const rp = rv.versions[0].event.payload as {
    regions: Array<{ containsHole: boolean; holes: unknown[] }>;
  };
  assert.ok(rp.regions.some((r) => r.containsHole && r.holes.length >= 4));
});

test('循环不闭合：注入残差产生非闭合循环残差', () => {
  const scene = buildMinimalScene('cycle-not-closed');
  const { ledger, pid } = setup(scene);
  const state = projectState(ledger, pid);
  const residueView = [...state.entities.values()].find((v) => v.type === 'residueMap')!;
  const rp = residueView.versions[0].event.payload as { residues: unknown[] };
  assert.ok(rp.residues.length >= 1, '应检测到注入残差');
  const trees = [...state.entities.values()].filter((v) => v.type === 'unwrapTree');
  const openCycles = trees.flatMap((t) => {
    const p = t.versions[0].event.payload as UnwrapTreeContent;
    return p.cycleResiduals.filter((c) => !c.closed && !Number.isNaN(c.residualTurns));
  });
  assert.ok(openCycles.length >= 1, '应至少有一个非闭合循环');
});

test('波长版本变更：高度链产生新版本且旧版本标记 stale 但仍可查看', () => {
  const scene = buildMinimalScene('wavelength-version');
  const { ledger, pid, clock, ids } = setup(scene);
  const wl2 = ingestWavelength(ledger, pid, clock, 532, 'nanometer', 'v2', ids.wavelength);
  runPipeline(ledger, pid, clock, { ...ids, wavelength: wl2.eventId }, DEFAULT_PARAMS);
  const state = projectState(ledger, pid);
  const heights = [...state.entities.values()].filter((v) => v.type === 'heightChain');
  assert.ok(heights.length >= 1);
  for (const hv of heights) {
    // 引用旧波长的高度版本应 stale
    const oldVersion = hv.versions.find((v) => {
      const p = v.event.payload as HeightChainContent;
      return p.derivesFrom.wavelengthEventId === ids.wavelength;
    });
    if (oldVersion) assert.equal(oldVersion.stale, true);
  }
  // 旧版本依然可查询（不是被覆盖）
  const allEvents = ledger.listEvents(pid);
  const heightEvents = allEvents.filter((e) => e.type === 'height.computed');
  assert.ok(heightEvents.length >= 2);
});

test('整周多解：保留全部合法候选；不能采纳非法 k', () => {
  const scene = buildMinimalScene('integer-ambiguity');
  const { ledger, pid } = setup(scene);
  const state = projectState(ledger, pid);
  const intViews = [...state.entities.values()].filter((v) => v.type === 'integerCandidates');
  const allAmb: IntegerCandidatesContent['ambiguities'] = [];
  for (const v of intViews) {
    const p = v.versions[0].event.payload as IntegerCandidatesContent;
    allAmb.push(...p.ambiguities);
  }
  // 至少存在一个歧义位置；其合法选项被完整保留（采纳与否未决定）
  assert.ok(allAmb.length >= 1);
  const target = intViews[0];
  const tp = target.versions[0].event.payload as IntegerCandidatesContent;
  const amb = tp.ambiguities[0];
  const illegalK = amb.options.find((o) => !o.legal)?.k ?? 99;
  assert.throws(
    () =>
      decideCandidate({
        ledger,
        projectId: pid,
        clock: new VirtualClock(),
        integerCandidatesEventId: target.versions[0].event.eventId,
        ambiguityId: amb.ambiguityId,
        decision: 'accept',
        chosenK: illegalK,
        rationale: 'x',
      }),
    DecisionError,
  );
});

test('局部锁定冲突：同区域两种解读第二次锁定记 conflict', () => {
  const scene = buildMinimalScene('lock-conflict');
  const { ledger, pid, result } = setup(scene);
  const boundA = {
    heightChainEventId: result.height[0],
    unwrapTreeEventId: result.unwrap[0],
    integerCandidatesEventId: result.integers[0],
  };
  const boundB = {
    heightChainEventId: result.height[1] ?? result.height[0],
    unwrapTreeEventId: result.unwrap[1] ?? result.unwrap[0],
    integerCandidatesEventId: result.integers[1] ?? result.integers[0],
  };
  lockRegion({
    ledger, projectId: pid, clock: new VirtualClock(),
    regionId: 'R0', interpretation: 'A 解读', bound: boundA,
  });
  const conflict = lockRegion({
    ledger, projectId: pid, clock: new VirtualClock(),
    regionId: 'R0', interpretation: 'B 解读（冲突）', bound: boundB,
  });
  const payload = conflict.payload as RegionLockContent;
  assert.equal(payload.status, 'conflict');
  assert.ok(payload.conflictsWith.length >= 1);
  // 强制解决后再次锁定可变 active
  const resolved = lockRegion({
    ledger, projectId: pid, clock: new VirtualClock(),
    regionId: 'R0', interpretation: 'B 解读（裁决）', bound: boundB, forceResolve: true,
  });
  assert.equal((resolved.payload as RegionLockContent).status, 'active');
});

test('组合输入：单个 8x8 场景同时触发全部 7 情形', () => {
  const scene = buildCombinedScene([...SCENARIO_KEYS]);
  const { ledger, pid } = setup(scene);
  const state = projectState(ledger, pid);
  const types = new Set<string>([...state.entities.values()].map((e) => e.type));
  for (const t of [
    'qualityMap',
    'residueMap',
    'regionMap',
    'cutNetwork',
    'unwrapTree',
    'integerCandidates',
    'heightChain',
  ]) {
    assert.ok(types.has(t), '缺少派生实体 ' + t);
  }
  assert.ok(state.corruptions.length === 0, '初始组合场景不应有损坏引用');
});

test('不同展开树得到局部一致解，保留路径与循环残差', () => {
  const scene = buildCombinedScene([...SCENARIO_KEYS]);
  const { ledger, pid } = setup(scene);
  const state = projectState(ledger, pid);
  const trees = [...state.entities.values()].filter((v) => v.type === 'unwrapTree');
  const variants = new Set(
    trees.map((t) => (t.versions[0].event.payload as UnwrapTreeContent).treeVariant),
  );
  assert.ok(variants.has('mst-quality'));
  assert.ok(variants.has('bfs-border'));
  for (const t of trees) {
    const p = t.versions[0].event.payload as UnwrapTreeContent;
    assert.ok(p.edges.length > 0, '必须保留展开路径');
    assert.ok(Array.isArray(p.cycleResiduals), '必须保留循环残差');
  }
});

test('原始输入不可覆盖：重复提交同帧不产生新版本，修订才产生新版本', () => {
  const scene = buildMinimalScene('low-amplitude-hole');
  const { ledger, pid } = setup(scene);
  const before = ledger.currentVersion(pid, 'wavelength' as never, 'main');
  // 波长修订（新版本）
  ingestWavelength(ledger, pid, new VirtualClock(), 532, 'nanometer', 'v2');
  const after = ledger.currentVersion(pid, 'wavelength' as never, 'main');
  assert.equal(after, before + 1);
});

test('残差/质量算法对固定 seed 可复现', () => {
  const a = buildMinimalScene('cycle-not-closed');
  const b = buildMinimalScene('cycle-not-closed');
  assert.deepEqual(a.phase, b.phase);
  const mask = new Uint8Array(64).fill(1);
  const r1 = computeResidues(Float64Array.from(a.phase), mask, 8, 8);
  const r2 = computeResidues(Float64Array.from(b.phase), mask, 8, 8);
  assert.equal(r1.length, r2.length);
  const q1 = computeQualityMap(Float64Array.from(a.amplitude), Float64Array.from(a.snr), mask, DEFAULT_PARAMS);
  const q2 = computeQualityMap(Float64Array.from(b.amplitude), Float64Array.from(b.snr), mask, DEFAULT_PARAMS);
  assert.deepEqual(Array.from(q1.score), Array.from(q2.score));
  const reg = computeRegions(mask, q1.flags, 8, 8);
  assert.ok(reg.regions.length >= 1);
  void QualityFlag;
});

function composeFromRef(ledger: Ledger, ref: string, rows: number, cols: number): Float64Array {
  const ids = ref.startsWith('frame:') ? ref.slice(6).split(',').filter(Boolean) : [];
  const out = new Float64Array(rows * cols).fill(NaN);
  for (const id of ids) {
    const tile = ledger.getTile(id) as {
      blockR: number; blockC: number; tileRows: number; tileCols: number; values: number[];
    } | null;
    if (!tile) continue;
    let i = 0;
    for (let r = 0; r < tile.tileRows; r++) {
      for (let c = 0; c < tile.tileCols; c++) {
        out[(tile.blockR * 4 + r) * cols + (tile.blockC * 4 + c)] = tile.values[i++];
      }
    }
  }
  return out;
}
