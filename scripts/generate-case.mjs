/**
 * 生成「干涉条纹簿：相位展开、支路切口与光学标定分支」离线案例包。
 * 固定 seed，输出确定；重复运行产生相同文件。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'cases', 'interference-book');
const W = 16;
const H = 12;
const TWO_PI = Math.PI * 2;

const wrap = (v) => {
  let d = ((v + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
  if (d <= -Math.PI) d += TWO_PI;
  return d;
};
const grid = (fill = 0) => ({ width: W, height: H, data: new Array(W * H).fill(fill) });
const at = (g, x, y) => y * g.width + x;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ramp(sx, sy) {
  const g = grid();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g.data[at(g, x, y)] = wrap(sx * x + sy * y);
  return g;
}
const qualityFull = () => grid(0.9);
const maskNone = () => grid(0);

function holeQuality(cx, cy, r2, level = 0.05) {
  const q = qualityFull();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - cx, dy = y - cy;
    if (dx * dx + dy * dy <= r2) q.data[at(q, x, y)] = level;
  }
  return q;
}
function wallMask(col) {
  const m = maskNone();
  for (let y = 0; y < H; y++) m.data[at(m, col, y)] = 1;
  return m;
}
const setPx = (g, x, y, v) => { g.data[at(g, x, y)] = v; };
function craftResiduePlus(g, px, py) {
  setPx(g, px, py, 0); setPx(g, px + 1, py, Math.PI / 2);
  setPx(g, px + 1, py + 1, Math.PI); setPx(g, px, py + 1, -Math.PI / 2);
}
function craftResidueMinus(g, px, py) {
  setPx(g, px, py, 0); setPx(g, px + 1, py, -Math.PI / 2);
  setPx(g, px + 1, py + 1, -Math.PI); setPx(g, px, py + 1, Math.PI / 2);
}
function craftSpike(g, x, y) {
  const i = at(g, x, y);
  g.data[i] = wrap(g.data[i] + Math.PI);
}

const SCENARIOS = {
  'phase-crossing-boundary': () => ({ wrappedPhase: ramp(0.9, 0.35), quality: qualityFull(), invalidMask: maskNone() }),
  'low-amplitude-hole': () => ({ wrappedPhase: ramp(0.6, 0.2), quality: holeQuality(8, 6, 6), invalidMask: maskNone() }),
  'multi-connected-region': () => ({ wrappedPhase: ramp(0.5, 0.3), quality: qualityFull(), invalidMask: wallMask(8) }),
  'cycle-non-closure': () => {
    const g = ramp(0.4, 0.25);
    craftResiduePlus(g, 3, 3);
    craftResidueMinus(g, 12, 8);
    craftSpike(g, 8, 5);
    return { wrappedPhase: g, quality: qualityFull(), invalidMask: maskNone() };
  },
  'wavelength-version-change': () => ({ wrappedPhase: ramp(0.7, 0.15), quality: qualityFull(), invalidMask: maskNone() }),
  'integer-multi-solution': () => {
    const g = ramp(0.35, 0.2);
    craftResiduePlus(g, 2, 2);
    craftResidueMinus(g, 13, 2);
    craftResiduePlus(g, 2, 8);
    craftResidueMinus(g, 13, 8);
    return { wrappedPhase: g, quality: qualityFull(), invalidMask: maskNone() };
  },
  'local-lock-conflict': () => {
    const g = ramp(0.3, 0.2);
    for (let y = 4; y < 8; y++) for (let x = 4; x < 10; x++) {
      const i = at(g, x, y);
      g.data[i] = wrap(g.data[i] + 1.2);
    }
    return { wrappedPhase: g, quality: qualityFull(), invalidMask: maskNone() };
  },
};

function combined(seed) {
  const rand = mulberry32(seed);
  const g = ramp(0.8, 0.3);
  craftResiduePlus(g, 8, 6);
  craftResidueMinus(g, 13, 9);
  craftSpike(g, 10, 3);
  const q = qualityFull();
  const m = wallMask(12);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = at(g, x, y);
    const dx = x - 4, dy = y - 4;
    if (dx * dx + dy * dy <= 3) q.data[i] = 0.04;
    else q.data[i] = Math.min(1, q.data[i] + (rand() - 0.5) * 0.1);
  }
  return { wrappedPhase: g, quality: q, invalidMask: m };
}

function write(rel, value) {
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(value, null, 1) + '\n');
  console.log('wrote', rel);
}

// ---- 基线：七种不可覆盖输入 ----
const base = SCENARIOS['phase-crossing-boundary']();
write('baseline/wrapped_phase.json', base.wrappedPhase);
write('baseline/quality_map.json', base.quality);
write('baseline/invalid_mask.json', base.invalidMask);
write('baseline/wavelength.json', { wavelength: { value: 632.8, unit: 'nm' }, frame: 'sample-plane' });
write('baseline/incidence_geometry.json', {
  angle: { value: 30, unit: 'deg' },
  passFactor: 2,
  frame: 'sample-plane',
});
write('baseline/calibration_plane.json', { a: 0.4, b: -0.2, c: 12.5, unit: 'nm', frame: 'sample-plane' });
write('baseline/cut_edit_history.json', { edits: [] });

// ---- 修订：参数修订（波长版本变更）+ 局部源数据改动 ----
write('revisions/wavelength_v2.json', { wavelength: { value: 635.0, unit: 'nm' }, frame: 'sample-plane' });
write('revisions/quality_local_patch.json', (() => {
  const q = qualityFull();
  for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) q.data[at(q, x, y)] = 0.1;
  return q;
})());

// ---- 七个情形：最小输入 + 组合输入（共享原始片段内容相同，存储层按内容去重）----
for (const [id, build] of Object.entries(SCENARIOS)) {
  const minimal = build();
  const comb = combined(1217);
  write(`scenarios/${id}/minimal/wrapped_phase.json`, minimal.wrappedPhase);
  write(`scenarios/${id}/minimal/quality_map.json`, minimal.quality);
  write(`scenarios/${id}/minimal/invalid_mask.json`, minimal.invalidMask);
  write(`scenarios/${id}/combined/wrapped_phase.json`, comb.wrappedPhase);
  write(`scenarios/${id}/combined/quality_map.json`, comb.quality);
  write(`scenarios/${id}/combined/invalid_mask.json`, comb.invalidMask);
}

// ---- 重放脚本：基线 → 参数修订 → 局部源改动 → 冲突人工决定 → 七情形 ----
const replay = [
  { op: 'commit', kind: 'wrapped_phase', entityId: 'book/wrapped-phase', file: 'baseline/wrapped_phase.json', meta: { units: 'rad', note: 'HeNe 干涉包裹相位' } },
  { op: 'commit', kind: 'quality_map', entityId: 'book/quality-map', file: 'baseline/quality_map.json', meta: { units: 'score:0..1' } },
  { op: 'commit', kind: 'invalid_mask', entityId: 'book/invalid-mask', file: 'baseline/invalid_mask.json', meta: { units: '0/1' } },
  { op: 'commit', kind: 'wavelength', entityId: 'book/wavelength', file: 'baseline/wavelength.json', meta: { units: 'nm' } },
  { op: 'commit', kind: 'incidence_geometry', entityId: 'book/geometry', file: 'baseline/incidence_geometry.json', meta: { units: 'deg' } },
  { op: 'commit', kind: 'calibration_plane', entityId: 'book/calibration', file: 'baseline/calibration_plane.json', meta: { units: 'nm' } },
  { op: 'commit', kind: 'cut_edit_history', entityId: 'book/cut-edits', file: 'baseline/cut_edit_history.json', meta: { units: 'edges' } },
  { op: 'unwrap', save: 'baseline-cands', phase: 'book/wrapped-phase', quality: 'book/quality-map', mask: 'book/invalid-mask', params: { strategy: 'best-quality' } },
  { op: 'height', save: 'baseline-height', candidate: 'baseline-cands[0]', wavelength: 'book/wavelength', geometry: 'book/geometry', calibration: 'book/calibration' },
  { op: 'decide', result: 'baseline-cands[0]', action: 'accept', reason: '基线展开树循环残差为零，接受为当前解' },
  { op: 'commit', kind: 'wavelength', entityId: 'book/wavelength', file: 'revisions/wavelength_v2.json', meta: { units: 'nm', note: '参数修订：632.8nm → 635.0nm（激光器复标定）' } },
  { op: 'height', save: 'height-v2', candidate: 'baseline-cands[0]', wavelength: 'book/wavelength', geometry: 'book/geometry', calibration: 'book/calibration' },
  { op: 'commit', kind: 'quality_map', entityId: 'book/quality-map', file: 'revisions/quality_local_patch.json', meta: { units: 'score:0..1', region: { x: 2, y: 2, width: 4, height: 4 }, note: '局部源数据改动：仅 (2,2)-(5,5) 区域重新评分' } },
  { op: 'run-scenario', id: 'phase-crossing-boundary' },
  { op: 'run-scenario', id: 'low-amplitude-hole' },
  { op: 'run-scenario', id: 'multi-connected-region' },
  { op: 'run-scenario', id: 'cycle-non-closure' },
  { op: 'run-scenario', id: 'wavelength-version-change' },
  { op: 'run-scenario', id: 'integer-multi-solution' },
  { op: 'run-scenario', id: 'local-lock-conflict' },
  { op: 'decide', result: 'scn:cycle-non-closure[0]', action: 'reject', reason: '存在未配对残差，循环不闭合未消解' },
  { op: 'undo-last-decision' },
  { op: 'lock', save: 'lock-a', result: 'scn:local-lock-conflict[0]', region: { x: 4, y: 4, width: 6, height: 4 }, kOffsets: { 'component:0': 0 } },
  { op: 'lock', save: 'lock-b', result: 'scn:local-lock-conflict[0]', region: { x: 6, y: 4, width: 4, height: 4 }, kOffsets: { 'component:0': 1 } },
  { op: 'resolve-lock', keep: 'lock-b', drop: 'lock-a', reason: '现场复测支持 component:0 整周偏移为 +1' },
];

write('replay.json', { description: '干涉条纹簿重放记录：基线→参数修订→局部源改动→冲突决定→七情形', steps: replay });
write('case.json', {
  id: 'interference-book',
  title: '干涉条纹簿：相位展开、支路切口与光学标定分支',
  grid: { width: W, height: H },
  scenarios: Object.keys(SCENARIOS),
  rules: [
    'low-amplitude-no-guess',
    'explicit-cut-offsets',
    'keep-path-and-cycle-residuals',
    'immutable-inputs',
    'local-staleness',
    'no-fallback-to-latest',
  ],
});
console.log('case pack generated at', ROOT);
