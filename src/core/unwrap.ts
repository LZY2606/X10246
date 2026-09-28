import { Grid, idx, inBounds, neighbors4, wrapPhase } from './grid.js';
import type {
  Cut, CutEdit, CutOffset, CutSegment, CycleCheck, PlaquetteResidue,
  UnwrapCandidate, UnwrapParams, UnwrapResultData
} from './events.js';
import type { Diagnostic } from './units.js';

export interface UnwrapInputs {
  wrapped: Grid;      // 包裹相位 (rad)
  quality: Grid;      // 信噪评分
  mask: Grid;         // 1=有效 0=无效
  cutEdits: CutEdit[];// 切口编辑历史（按序重放）
}

const edgeKey = (a: { row: number; col: number }, b: { row: number; col: number }) => {
  const p = `${a.row},${a.col}`, q = `${b.row},${b.col}`;
  return p < q ? `${p}|${q}` : `${q}|${p}`;
};

/** 2x2 plaquette 的环路和（单位：整周）。 */
function plaquetteResidues(w: Grid, valid: boolean[]): PlaquetteResidue[] {
  const out: PlaquetteResidue[] = [];
  for (let r = 0; r < w.height - 1; r++) {
    for (let c = 0; c < w.width - 1; c++) {
      const pts = [
        { row: r, col: c }, { row: r, col: c + 1 },
        { row: r + 1, col: c + 1 }, { row: r + 1, col: c }
      ];
      if (!pts.every(p => valid[idx(w, p.row, p.col)])) continue;
      let sum = 0;
      for (let i = 0; i < 4; i++) {
        const a = pts[i], b = pts[(i + 1) % 4];
        sum += wrapPhase(w.data[idx(w, b.row, b.col)] - w.data[idx(w, a.row, a.col)]);
      }
      const cycles = Math.round(sum / (2 * Math.PI));
      out.push({
        row: r, col: c, sumCycles: cycles,
        status: cycles === 0 ? 'closed' : 'unclosed',
        diagnosis: cycles === 0 ? undefined
          : `循环不闭合：plaquette(${r},${c}) 环路和 ${cycles} 周，需支路切口或保留多解`
      });
    }
  }
  return out;
}

/** 残差配对 → 支路切口路径（L 形，落在像素邻接边上）。 */
function pairResidues(residues: PlaquetteResidue[], diagnostics: Diagnostic[]): Cut[] {
  const plus = residues.filter(r => r.sumCycles > 0).map(r => ({ row: r.row, col: r.col }));
  const minus = residues.filter(r => r.sumCycles < 0).map(r => ({ row: r.row, col: r.col }));
  const cuts: Cut[] = [];
  const usedMinus = new Set<number>();
  plus.forEach((p, i) => {
    let best = -1, bestD = Infinity;
    minus.forEach((m, j) => {
      if (usedMinus.has(j)) return;
      const d = Math.abs(p.row - m.row) + Math.abs(p.col - m.col);
      if (d < bestD) { bestD = d; best = j; }
    });
    if (best < 0) {
      diagnostics.push({
        code: 'UNPAIRED_RESIDUE',
        message: `正残差 plaquette(${p.row},${p.col}) 无配对，循环不闭合将保留为多解`,
        at: { row: p.row, col: p.col }
      });
      return;
    }
    usedMinus.add(best);
    const m = minus[best];
    const segments: CutSegment[] = [];
    let cr = p.row, cc = p.col;
    while (cr !== m.row) {           // 竖直移动跨过像素边 {(cr,cc),(cr+1,cc)}
      const nr = cr + Math.sign(m.row - cr);
      segments.push({ a: { row: Math.min(cr, nr), col: cc }, b: { row: Math.max(cr, nr), col: cc } });
      cr = nr;
    }
    while (cc !== m.col) {           // 水平移动跨过像素边 {(cr,cc),(cr,cc+1)}
      const nc = cc + Math.sign(m.col - cc);
      segments.push({ a: { row: cr, col: Math.min(cc, nc) }, b: { row: cr, col: Math.max(cc, nc) } });
      cc = nc;
    }
    cuts.push({ id: `cut_auto_${i}`, source: 'residue-pairing', segments });
  });
  minus.forEach((m, j) => {
    if (!usedMinus.has(j)) {
      diagnostics.push({
        code: 'UNPAIRED_RESIDUE',
        message: `负残差 plaquette(${m.row},${m.col}) 无配对，循环不闭合将保留为多解`,
        at: { row: m.row, col: m.col }
      });
    }
  });
  return cuts;
}

function applyManualEdits(edits: CutEdit[]): Cut[] {
  const cuts: Cut[] = [];
  for (const e of edits) {
    if (e.action === 'add') cuts.push({ id: `cut_edit_${e.editId}`, source: 'manual-edit', segments: e.segments });
    else {
      const removeKeys = new Set(e.segments.map(s => edgeKey(s.a, s.b)));
      for (const c of cuts) c.segments = c.segments.filter(s => !removeKeys.has(edgeKey(s.a, s.b)));
    }
  }
  return cuts.filter(c => c.segments.length > 0);
}

/** 主入口：质量引导 + 支路切口的二维相位展开。 */
export function computeUnwrap(inputs: UnwrapInputs, params: UnwrapParams): UnwrapResultData {
  const { wrapped, quality, mask } = inputs;
  const diagnostics: Diagnostic[] = [];
  const n = wrapped.width * wrapped.height;
  const valid = new Array<boolean>(n).fill(false);
  const holes: UnwrapResultData['holes'] = [];
  for (let r = 0; r < wrapped.height; r++) {
    for (let c = 0; c < wrapped.width; c++) {
      const i = idx(wrapped, r, c);
      if (mask.data[i] === 0) { holes.push({ row: r, col: c, reason: 'MASKED_INVALID' }); continue; }
      if (quality.data[i] < params.qualityThreshold) {
        // RULE_NO_GUESS_LOW_AMPLITUDE：低振幅区域不得猜相位
        holes.push({ row: r, col: c, reason: 'LOW_AMPLITUDE' });
        continue;
      }
      valid[i] = true;
    }
  }

  // 连通分量（多连通区各自独立展开，绝对整周关系未知）
  const compOf = new Array<number>(n).fill(-1);
  const components: number[][] = [];
  for (let i = 0; i < n; i++) {
    if (!valid[i] || compOf[i] >= 0) continue;
    const compIdx = components.length;
    const stack = [i]; compOf[i] = compIdx;
    const members: number[] = [];
    while (stack.length) {
      const cur = stack.pop()!;
      members.push(cur);
      const cr = Math.floor(cur / wrapped.width), cc = cur % wrapped.width;
      for (const nb of neighbors4(wrapped, cr, cc)) {
        const j = idx(wrapped, nb.row, nb.col);
        if (valid[j] && compOf[j] < 0) { compOf[j] = compIdx; stack.push(j); }
      }
    }
    components.push(members);
  }
  if (components.length > 1) {
    diagnostics.push({
      code: 'MULTI_CONNECTED',
      message: `多连通区：${components.length} 个分量独立展开，分量间绝对整周偏移未知`,
    });
    diagnostics.push({ code: 'INTER_COMPONENT_OFFSET_UNKNOWN', message: '分量间 k 偏移保留为未知，不做猜测' });
  }

  const residues = plaquetteResidues(wrapped, valid);
  const autoCuts = pairResidues(residues, diagnostics);
  const manualCuts = applyManualEdits(inputs.cutEdits);
  const cuts = [...autoCuts, ...manualCuts];
  const cutEdgeSet = new Set<string>();
  for (const cut of cuts) for (const s of cut.segments) cutEdgeSet.add(edgeKey(s.a, s.b));

  // 每分量 BFS 生成树（不跨切口），赋整周数 k
  const k = new Array<number | null>(n).fill(null);
  const treeEdges: UnwrapResultData['treeEdges'] = [];
  const bfsPath: Array<{ row: number; col: number }> = [];
  for (const members of components) {
    let anchorIdx = members[0];
    let k0 = 0;
    if (params.anchor !== 'auto') {
      const ai = idx(wrapped, params.anchor.row, params.anchor.col);
      if (valid[ai] && compOf[ai] === compOf[members[0]]) { anchorIdx = ai; k0 = params.anchor.k0; }
    }
    k[anchorIdx] = k0;
    const queue = [anchorIdx];
    while (queue.length) {
      const cur = queue.shift()!;
      const cr = Math.floor(cur / wrapped.width), cc = cur % wrapped.width;
      bfsPath.push({ row: cr, col: cc });
      for (const nb of neighbors4(wrapped, cr, cc)) {
        const j = idx(wrapped, nb.row, nb.col);
        if (!valid[j] || k[j] !== null) continue;
        if (cutEdgeSet.has(edgeKey({ row: cr, col: cc }, nb))) continue; // 切口不可跨越
        k[j] = k[cur]! + Math.round(wrapPhase(wrapped.data[j] - wrapped.data[cur]) / (2 * Math.PI));
        treeEdges.push({ from: { row: cr, col: cc }, to: nb });
        queue.push(j);
      }
    }
    // 切口隔离的孤岛：退化为允许跨切口的第二遍，但记录诊断
    const unreached = members.filter(m => k[m] === null);
    if (unreached.length) {
      diagnostics.push({
        code: 'CUT_ISOLATED_ISLAND',
        message: `${unreached.length} 像素被切口/孔洞隔离，以未知偏移独立展开`
      });
      for (const start of unreached) {
        if (k[start] !== null) continue;
        k[start] = 0;
        const queue2 = [start];
        while (queue2.length) {
          const cur = queue2.shift()!;
          const cr = Math.floor(cur / wrapped.width), cc = cur % wrapped.width;
          for (const nb of neighbors4(wrapped, cr, cc)) {
            const j = idx(wrapped, nb.row, nb.col);
            if (!valid[j] || k[j] !== null) continue;
            k[j] = k[cur]! + Math.round(wrapPhase(wrapped.data[j] - wrapped.data[cur]) / (2 * Math.PI));
            treeEdges.push({ from: { row: cr, col: cc }, to: nb });
            queue2.push(j);
          }
        }
      }
    }
  }

  // 循环校验：每个 plaquette 用已赋 k 复算环路残差
  const cycleChecks: CycleCheck[] = [];
  for (let r = 0; r < wrapped.height - 1; r++) {
    for (let c = 0; c < wrapped.width - 1; c++) {
      const pts = [
        { row: r, col: c }, { row: r, col: c + 1 },
        { row: r + 1, col: c + 1 }, { row: r + 1, col: c }
      ];
      if (!pts.every(p => valid[idx(wrapped, p.row, p.col)])) continue;
      let residual = 0;
      for (let i = 0; i < 4; i++) {
        const a = pts[i], b = pts[(i + 1) % 4];
        const ia = idx(wrapped, a.row, a.col), ib = idx(wrapped, b.row, b.col);
        const expected = Math.round(wrapPhase(wrapped.data[ib] - wrapped.data[ia]) / (2 * Math.PI));
        residual += (k[ib]! - k[ia]!) - expected;
      }
      cycleChecks.push({
        nodes: pts, residualCycles: residual, closed: residual === 0
      });
    }
  }
  const unclosed = cycleChecks.filter(cy => !cy.closed);
  for (const cy of unclosed) {
    diagnostics.push({
      code: 'CYCLE_NOT_CLOSED',
      message: `循环不闭合：plaquette(${cy.nodes[0].row},${cy.nodes[0].col}) 残差 ${cy.residualCycles} 周`,
      at: { row: cy.nodes[0].row, col: cy.nodes[0].col }
    });
  }

  // 切口两侧显式整周偏移
  const cutOffsets: CutOffset[] = [];
  cuts.forEach(cut => {
    cut.segments.forEach((s, si) => {
      const ia = idx(wrapped, s.a.row, s.a.col), ib = idx(wrapped, s.b.row, s.b.col);
      if (!valid[ia] || !valid[ib]) return;
      const deltaK = (k[ib]! - k[ia]!)
        - Math.round(wrapPhase(wrapped.data[ib] - wrapped.data[ia]) / (2 * Math.PI));
      cutOffsets.push({ cutId: cut.id, segmentIndex: si, deltaK });
    });
  });

  // 候选：整周多解（锚点 k0 歧义）+ 循环不闭合的局部一致替代解
  const candidates: UnwrapCandidate[] = [];
  const basePath = bfsPath.filter((_, i2) => i2 % Math.max(1, Math.floor(bfsPath.length / 16)) === 0);
  const k0Values = params.anchor === 'auto' ? [0, 1, -1] : [0];
  k0Values.forEach((k0, ki) => {
    const kg = k.map(v => (v === null ? null : v + k0));
    candidates.push({
      candidateId: `cand_base_k0_${k0}`,
      label: k0 === 0 ? '基准解 k0=0' : `整周平移 k0=${k0 > 0 ? '+' : ''}${k0}`,
      kGrid: kg,
      path: basePath,
      cycleResiduals: cycleChecks,
      rejectedReasons: [],
      status: 'open'
    });
    void ki;
  });
  // 每个不闭合循环生成一个局部替代解：从 plaquette 一角泛洪，区域整体 +1
  for (const cy of unclosed.slice(0, Math.max(0, params.maxCandidates - candidates.length))) {
    const seed = cy.nodes[0];
    const region = new Array<boolean>(n).fill(false);
    const wall = new Set<string>();
    for (let i2 = 0; i2 < 4; i2++) wall.add(edgeKey(cy.nodes[i2], cy.nodes[(i2 + 1) % 4]));
    const stack = [idx(wrapped, seed.row, seed.col)];
    region[stack[0]] = true;
    while (stack.length) {
      const cur = stack.pop()!;
      const cr = Math.floor(cur / wrapped.width), cc = cur % wrapped.width;
      for (const nb of neighbors4(wrapped, cr, cc)) {
        const j = idx(wrapped, nb.row, nb.col);
        if (!valid[j] || region[j]) continue;
        if (wall.has(edgeKey({ row: cr, col: cc }, nb))) continue;
        if (cutEdgeSet.has(edgeKey({ row: cr, col: cc }, nb))) continue;
        region[j] = true; stack.push(j);
      }
    }
    const kg = k.map((v, i2) => (v === null ? null : v + (region[i2] ? 1 : 0)));
    candidates.push({
      candidateId: `cand_cycle_${cy.nodes[0].row}_${cy.nodes[0].col}_plus1`,
      label: `循环(${cy.nodes[0].row},${cy.nodes[0].col}) 区域 +1 周`,
      kGrid: kg,
      path: [...basePath, seed],
      cycleResiduals: cycleChecks,
      rejectedReasons: [],
      status: 'open'
    });
  }
  if (unclosed.length + k0Values.length > params.maxCandidates) {
    diagnostics.push({
      code: 'CANDIDATE_CAP',
      message: `合法候选超过 maxCandidates=${params.maxCandidates}，超出部分保留为未展开记录`
    });
  }

  return {
    width: wrapped.width, height: wrapped.height,
    components: components.length,
    holes, residues, cuts, cutOffsets, treeEdges, candidates, diagnostics
  };
}

/** 解包裹：φ + 2πk；孔洞返回 null。 */
export function unwrappedPhase(wrapped: Grid, kGrid: (number | null)[]): (number | null)[] {
  return wrapped.data.map((v, i) => (kGrid[i] === null ? null : v + 2 * Math.PI * (kGrid[i] as number)));
}

export function gridFromArrays(width: number, height: number, data: number[]): Grid {
  if (data.length !== width * height) throw new Error(`网格尺寸不符: ${width}x${height} != ${data.length}`);
  return { width, height, data: [...data] };
}

export { inBounds };
