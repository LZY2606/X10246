/**
 * 离线案例包：干涉条纹簿 —— 相位展开、支路切口与光学标定分支。
 *
 * 产物（确定性、可提交进仓库）：
 *   casepack/interferometry-ledger/manifest.json
 *   casepack/.../fragments/<digest>.json   共享不可变原始片段（只存一份）
 *   casepack/.../counterexamples/<kind>/{minimal,combined}.json
 *
 * 七个情形各一个最小输入与一个组合输入；它们共享的原始片段只存一份
 * 不可变内容，而解释版本/失败诊断/人工决定保持独立。
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash, canonicalJson, SeededRng, VirtualClock } from '../src/core/identity.js';
import { LedgerStore } from '../src/server/store.js';
import initSqlJs from 'sql.js';
import { LedgerApp } from '../src/core/app.js';
import type { CounterexampleKind, RawSourceBundle } from '../src/shared/model.js';
import {
  N,
  baseLayers,
  crossingBoundaryLayers,
  lowAmpHoleLayers,
  multiplyConnectedLayers,
  unclosedCycleLayers,
  integerMultiplicityLayers,
  wavelengthChangeLayers,
  lockConflictLayers,
  toImport,
} from './casepack-shared.js';
import { DEFAULT_PARAMS } from '../src/core/params.js';
import { buildQuality } from '../src/core/quality.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', 'casepack', 'interferometry-ledger');
const FRAG = join(ROOT, 'fragments');
const CE = join(ROOT, 'counterexamples');

interface ScenarioSpec {
  kind: CounterexampleKind;
  title: string;
  build: () => ReturnType<typeof baseLayers>;
  /** 组合输入在最小情形基础上叠加额外压力 */
  combine: (layers: ReturnType<typeof baseLayers>) => ReturnType<typeof baseLayers>;
  expectation: Record<string, unknown>;
}

const scenarios: ScenarioSpec[] = [
  {
    kind: 'phase-crossing-boundary',
    title: '相位跨越边界',
    build: crossingBoundaryLayers,
    combine: (s) => addLocalHole(s, 2, 2),
    expectation: { wraps: '>0', containment: '仅跨边界像素的 wrapK 改变，远离边界者不变' },
  },
  {
    kind: 'low-amplitude-hole',
    title: '低振幅孔洞',
    build: lowAmpHoleLayers,
    combine: (s) => addLocalHole(s, 11, 11),
    expectation: { holePixels: 'unknown(low-amplitude)', noGuessing: true },
  },
  {
    kind: 'multiply-connected-region',
    title: '多连通区',
    build: multiplyConnectedLayers,
    combine: (s) => addLocalHole(s, 12, 2),
    expectation: { components: '>=2', anchorCandidates: '内部分量锚点给出 {-1,0,+1}' },
  },
  {
    kind: 'unclosed-cycle',
    title: '循环不闭合',
    build: unclosedCycleLayers,
    combine: (s) => addLocalHole(s, 12, 12),
    expectation: { residues: '>=2', branchCuts: true, cycleResidual: '跨缝环路 ±1 cycle' },
  },
  {
    kind: 'wavelength-version-change',
    title: '波长版本变更',
    build: wavelengthChangeLayers,
    combine: (s) => addLocalHole(s, 12, 12),
    expectation: { stale: '仅高度链过期，展开树不变', unit: 'nm->nm(revision)' },
  },
  {
    kind: 'integer-multiplicity',
    title: '整周多解',
    build: integerMultiplicityLayers,
    combine: (s) => addLocalHole(s, 2, 12),
    expectation: { candidates: '缝两侧合法 k 多解保留', rejectedReasonKept: true },
  },
  {
    kind: 'local-lock-conflict',
    title: '局部锁定冲突',
    build: lockConflictLayers,
    combine: (s) => addLocalHole(s, 2, 12),
    expectation: { conflict: '同像素不同 lockedK -> conflict，不覆盖旧锁' },
  },
];

function addLocalHole(s: ReturnType<typeof baseLayers>, r0: number, c0: number) {
  const clone = {
    phase: [...s.phase],
    amplitude: [...s.amplitude],
    mask: [...s.mask],
    snr: [...s.snr],
  };
  for (let dr = 0; dr < 2; dr++)
    for (let dc = 0; dc < 2; dc++) {
      const i = (r0 + dr) * 16 + (c0 + dc);
      clone.mask[i] = true;
      clone.amplitude[i] = 0;
      clone.snr[i] = 0;
    }
  return clone;
}

function immutableFragment(bundle: RawSourceBundle) {
  // 不可变基线内容：原相位/信噪/遮罩/波长/几何/标定面/切口历史
  const content = {
    wrappedPhase: bundle.wrappedPhase,
    amplitude: bundle.amplitude,
    invalidMask: bundle.invalidMask,
    snr: bundle.snr,
    wavelength: bundle.wavelength,
    geometry: bundle.geometry,
    calibration: bundle.calibration,
    cutHistory: bundle.cutHistory,
    grid: bundle.grid,
  };
  return { content, digest: contentHash(content) };
}

async function main() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(FRAG, { recursive: true });
  mkdirSync(CE, { recursive: true });

  const SQL = await initSqlJs();
  const rng = new SeededRng(20260919);
  const clock = new VirtualClock(1_700_000_000_000);
  const store = await LedgerStore.open(SQL);
  const app = new LedgerApp(store, 'casepack-ledger', rng, clock);

  const manifest: Record<string, unknown> = {
    name: '干涉条纹簿：相位展开、支路切口与光学标定分支',
    version: '1.0.0',
    grid: { rows: 16, cols: 16 },
    baselineRule:
      '原相位像素、信噪评分、无效遮罩、波长、入射几何、标定面和切口编辑历史均不可覆盖',
    fragmentDedup: '共享原始片段按 contentHash 只存一份不可变内容',
    scenarios: [] as unknown[],
  };

  const writtenFragments = new Set<string>();
  const baseline = toImport('src-baseline', '基线（不可覆盖）', baseLayers(), clock.now());
  const baseFrag = immutableFragment(baseline);
  writeFragment(baseFrag.digest, baseFrag.content, writtenFragments);
  app.archiveFragment('baseline', baseline.sourceId, baseFrag.content);

  for (const sc of scenarios) {
    const dir = join(CE, sc.kind);
    mkdirSync(dir, { recursive: true });

    const minLayers = sc.build();
    const combLayers = sc.combine(JSON.parse(JSON.stringify(minLayers)));
    const minBundle = toImport(`src-${sc.kind}-min`, `${sc.title}·最小输入`, minLayers, clock.now());
    const combBundle = toImport(`src-${sc.kind}-comb`, `${sc.title}·组合输入`, combLayers, clock.now());

    // 与基线相同的原始片段 -> 复用同一 digest（只存一份）
    const minFrag = immutableFragment(minBundle);
    const combFrag = immutableFragment(combBundle);
    writeFragment(minFrag.digest, minFrag.content, writtenFragments);
    writeFragment(combFrag.digest, combFrag.content, writtenFragments);
    app.archiveFragment(sc.kind, minBundle.sourceId, minFrag.content);
    app.archiveFragment(sc.kind, combBundle.sourceId, combFrag.content);

    // 解释版本：两者各自独立地导入、分析并做出独立诊断/决定
    const minRun = await runScenario(app, minBundle, sc, 'minimal');
    const combRun = await runScenario(app, combBundle, sc, 'combined');

    writeFileSync(join(dir, 'minimal.json'), canonicalJson({
      kind: sc.kind, variant: 'minimal', title: sc.title,
      sourceId: minBundle.sourceId, fragmentDigest: minFrag.digest,
      import: stripBundle(minBundle), expectation: sc.expectation,
      interpretation: minRun,
    }) + '\n');
    writeFileSync(join(dir, 'combined.json'), canonicalJson({
      kind: sc.kind, variant: 'combined', title: sc.title,
      sourceId: combBundle.sourceId, fragmentDigest: combFrag.digest,
      import: stripBundle(combBundle), expectation: sc.expectation,
      interpretation: combRun,
    }) + '\n');

    (manifest.scenarios as unknown[]).push({
      kind: sc.kind,
      title: sc.title,
      minimal: `counterexamples/${sc.kind}/minimal.json`,
      combined: `counterexamples/${sc.kind}/combined.json`,
      minimalFragment: minFrag.digest,
      combinedFragment: combFrag.digest,
      sharedFragmentWithBaseline: minFrag.digest === baseFrag.digest,
      expectation: sc.expectation,
    });
  }

  manifest.integrity = app.verifyIntegrity();
  manifest.fragmentCount = store.fragmentCount();
  writeFileSync(join(ROOT, 'manifest.json'), canonicalJson(manifest) + '\n');

  // 一份可直接导入 UI 的 SQLite 快照（含完整事件链）
  const snapshot = store.exportBytes();
  writeFileSync(join(ROOT, 'ledger.sqlite'), Buffer.from(snapshot));

  console.log(`casepack written: ${(manifest.scenarios as unknown[]).length} scenarios, ${store.fragmentCount()} fragments`);
  store.close();

  function writeFragment(digest: string, content: unknown, seen: Set<string>) {
    if (seen.has(digest)) return;
    seen.add(digest);
    writeFileSync(join(FRAG, `${digest.replace('sha256:', '')}.json`), canonicalJson(content) + '\n');
  }
}

function stripBundle(b: RawSourceBundle) {
  return {
    sourceId: b.sourceId,
    parentSourceId: b.parentSourceId,
    label: b.label,
    rows: b.grid.rows,
    cols: b.grid.cols,
    // 数组以紧凑字符串保存可复制小样例（UI 也接受 JSON 数组形式）
    wrappedPhase: b.wrappedPhase.values.map((x) => Number(x.toFixed(6))),
    amplitude: b.amplitude.values.map((x) => Number(x.toFixed(6))),
    invalidMask: b.invalidMask.values,
    snr: b.snr.values.map((x) => Number(x.toFixed(6))),
    wavelength: b.wavelength,
    geometry: b.geometry,
    calibration: b.calibration,
  };
}

async function runScenario(app: LedgerApp, bundle: RawSourceBundle, sc: ScenarioSpec, variant: string) {
  app.importSource(bundle, { label: `${variant}` });
  const artifact = app.analyze(bundle, DEFAULT_PARAMS, [sc.kind], 'algorithm');

  // 针对情形的独立解释/诊断/人工决定
  const blockedCount = artifact.blocked.filter(Boolean).length;
  const { lowAmplitude } = buildQuality(bundle.amplitude, bundle.snr, bundle.invalidMask, DEFAULT_PARAMS.quality);
  const lowAmpCount = lowAmplitude.filter(Boolean).length - bundle.invalidMask.values.filter(Boolean).length;
  const unknownPixels = artifact.unwrap.trees
    .flatMap((t) => t.pixels.values)
    .filter((p) => p.status === 'unknown').length;
  const unclosedCycles = artifact.unwrap.trees.flatMap((t) => t.cycles).filter((c) => !c.closed).length;

  const evidence: Record<string, unknown> = {
    variant,
    residues: artifact.residues.length,
    cuts: artifact.cuts.length,
    components: artifact.unwrap.trees.length,
    candidates: artifact.unwrap.candidates.length,
    candidateReasons: artifact.unwrap.candidates.map((c) => c.ambiguityReason),
    blockedCount,
    lowAmplitudeCount: Math.max(0, lowAmpCount),
    unknownPixels,
    unclosedCycles,
    cutOffsets: artifact.unwrap.trees.flatMap((t) => t.cutOffsets),
  };

  // 被采纳与未采纳结果都保留：默认接受 minimal，否定 combined 中一个候选并说明
  if (variant === 'minimal') {
    app.verdict(artifact.analysisId, 'accepted', `采纳 ${sc.title} 的最小解释`);
  } else {
    app.verdict(artifact.analysisId, 'rejected', `组合输入下保守复核：${sc.title} 需人工裁定`);
  }
  // 多解候选：在组合分支显式拒绝一个 k 并记录原因（保留全部合法候选）
  for (const cand of artifact.unwrap.candidates.slice(0, 1)) {
    app.decideCandidate(cand.candidateId, null, cand.kOptions.map((k) => ({ k, reason: k === 0 ? '保守：不跨切口猜整周' : '整周偏移未唯一确定' })));
  }

  // 情形特有事件
  if (sc.kind === 'wavelength-version-change') {
    const wl2 = { ...bundle.wavelength, parentId: bundle.wavelength.wavelengthId, value: 532.0, revisionNote: '改用 532nm' };
    app.reviseWavelength(bundle.sourceId, wl2, [artifact.height.chainId]);
  }
  if (sc.kind === 'local-lock-conflict') {
    const a = artifact.unwrap.trees[0];
    if (a) {
      app.lockLocal(artifact.analysisId, a.anchor, 0, '初始锁定 k=0');
      app.lockLocal(artifact.analysisId, a.anchor, 1, '冲突锁定 k=1');
    }
  }

  app.recordCounterexample(sc.kind, {
    contained: true,
    affectedIds: [artifact.analysisId, ...artifact.unwrap.trees.map((t) => t.treeId)],
    evidence: JSON.stringify(evidence),
  });

  return evidence;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
