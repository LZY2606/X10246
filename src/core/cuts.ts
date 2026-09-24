import type { CutEditHistoryPayload, CutNetworkPayload, CutSegment, Grid, ResiduePayload } from '../shared/domain';
import { idx } from './grid';

/**
 * 支路切口（branch cuts）：将相反电荷的留数沿曼哈顿路径配对，
 * 未配对的留数连到最近边界。每条切口显式记录跨越它所需的整周偏移。
 * 手工切口（来自切口编辑历史）叠加在自动切口之上，不可覆盖历史本身。
 */
export function buildCutNetwork(
  residues: ResiduePayload,
  width: number,
  height: number,
  history: CutEditHistoryPayload,
): CutNetworkPayload {
  const pos: Array<{ x: number; y: number }> = [];
  const neg: Array<{ x: number; y: number }> = [];
  for (const c of residues.cycles) {
    if (!c.charged) continue;
    if (c.residualRad > 0) pos.push({ x: c.corners[0]![0], y: c.corners[0]![1] });
    else neg.push({ x: c.corners[0]![0], y: c.corners[0]![1] });
  }
  const usedN = new Set<number>();
  const cuts: CutSegment[] = [];
  let n = 0;
  for (const p of pos) {
    let best = -1; let bestD = Infinity;
    for (let j = 0; j < neg.length; j++) {
      if (usedN.has(j)) continue;
      const q = neg[j]!;
      const d = Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
      if (d < bestD || (d === bestD && (q.y * width + q.x) < ((neg[best]!.y * width) + neg[best]!.x))) {
        bestD = d; best = j;
      }
    }
    if (best >= 0) {
      usedN.add(best);
      const q = neg[best]!;
      cuts.push({
        id: `cut_auto_${n++}`,
        polyline: manhattan(p.x, p.y, q.x, q.y),
        offsetTurns: 1,
        source: 'auto',
      });
    } else {
      const b = nearestBorder(p, width, height);
      cuts.push({
        id: `cut_auto_${n++}`,
        polyline: manhattan(p.x, p.y, b.x, b.y),
        offsetTurns: 1,
        source: 'auto',
      });
    }
  }
  for (let j = 0; j < neg.length; j++) {
    if (usedN.has(j)) continue;
    const q = neg[j]!;
    const b = nearestBorder(q, width, height);
    cuts.push({ id: `cut_auto_${n++}`, polyline: manhattan(q.x, q.y, b.x, b.y), offsetTurns: -1, source: 'auto' });
  }
  for (const e of history.edits) {
    if (e.action === 'add') {
      cuts.push({ id: e.editId, polyline: e.polyline.map((p) => [...p] as [number, number]), offsetTurns: e.offsetTurns, source: 'manual' });
    }
    if (e.action === 'remove') {
      // 撤销切口：按编辑历史中的 editId 精确删除（历史仍保留）
      const k = cuts.findIndex((c) => c.id === e.editId);
      if (k >= 0) cuts.splice(k, 1);
    }
  }
  return { cuts, width, height };
}

function manhattan(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [[x0, y0]];
  let x = x0; let y = y0;
  const sx = x1 >= x0 ? 1 : -1;
  while (x !== x1) { x += sx; pts.push([x, y]); }
  const sy = y1 >= y0 ? 1 : -1;
  while (y !== y1) { y += sy; pts.push([x, y]); }
  return pts;
}
function nearestBorder(p: { x: number; y: number }, width: number, height: number) {
  const d = [p.x, p.y, width - 2 - p.x, height - 2 - p.y];
  const m = Math.min(...d.map((v) => Math.max(0, v)));
  if (m === Math.max(0, d[0]!)) return { x: 0, y: p.y };
  if (m === Math.max(0, d[1]!)) return { x: p.x, y: 0 };
  if (m === Math.max(0, d[2]!)) return { x: width - 2, y: p.y };
  return { x: p.x, y: height - 2 };
}

/** 把切口折线转为被禁止跨越的邻接边集合，键 = 较小像素索引*N+较大像素索引 */
export function cutEdgeSet(cuts: CutNetworkPayload): Set<string> {
  const s = new Set<string>();
  const W = cuts.width;
  for (const c of cuts.cuts) {
    for (let i = 0; i + 1 < c.polyline.length; i++) {
      const [x0, y0] = c.polyline[i]!;
      const [x1, y1] = c.polyline[i + 1]!;
      const a = y0 * W + x0; const b = y1 * W + x1;
      s.add(a < b ? `${a}>${b}` : `${b}>${a}`);
    }
  }
  return s;
}
