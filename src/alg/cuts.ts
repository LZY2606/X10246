import type { Grid2D, CutNetwork, CutEdge, AlgorithmProvenance, ResidueMap, CutEdit } from '../domain/types';

/**
 * 支路切口：将正负残差按最近邻配平（Goldstein 双极子的简化确定性版本，
 * 固定 seed），配平不掉的残差连到边界。切口两侧整周偏移显式保留为
 * 未裁定（null），绝不在此层猜测。
 * 人工 CutEdit 历史叠加其上：remove-cut/retract 可能使配平失效，
 * 表现为 unbalancedResidues（循环不闭合的一等数据）。
 */
export function computeCutNetwork(
  grid: Grid2D,
  residues: ResidueMap,
  edits: CutEdit[],
  rng: () => number,
  provenance: AlgorithmProvenance
): CutNetwork {
  const edges: CutEdge[] = [];
  const positives = residues.positiveResidues.map(([x, y]) => ({ x, y }));
  const negatives = residues.negativeResidues.map(([x, y]) => ({ x, y }));

  const usedP = new Set<number>();
  const usedN = new Set<number>();

  // 确定性配对：按到最近未用异号残差的距离贪心
  const pairOrder = positives
    .map((p, i) => ({ i, key: rng() }))
    .sort((a, b) => a.key - b.key)
    .map((o) => o.i);

  for (const pi of pairOrder) {
    if (usedP.has(pi)) continue;
    let best = -1;
    let bestD = Infinity;
    for (let ni = 0; ni < negatives.length; ni++) {
      if (usedN.has(ni)) continue;
      const d =
        Math.abs(positives[pi].x - negatives[ni].x) +
        Math.abs(positives[pi].y - negatives[ni].y) +
        rng() * 1e-9;
      if (d < bestD) {
        bestD = d;
        best = ni;
      }
    }
    if (best >= 0 && bestD <= grid.width + grid.height) {
      usedP.add(pi);
      usedN.add(best);
      edges.push({
        a: [positives[pi].x, positives[pi].y],
        b: [negatives[best].x, negatives[best].y],
        integerOrderAcross: null,
        source: 'auto-bipole',
        editId: null
      });
    }
  }

  // 叠加人工切口编辑历史（只追加；retract 撤销的切口不加入，撤销事件本身保留）
  const retracted = new Set<string>();
  for (const edit of edits) {
    if (edit.action === 'retract' && edit.retracts) retracted.add(edit.retracts);
  }
  for (const edit of edits) {
    if (edit.action === 'add-cut' && edit.edge && !retracted.has(edit.id) && !retracted.has(edit.parentId ?? '')) {
      const [x1, y1, x2, y2] = edit.edge;
      edges.push({
        a: [x1, y1], b: [x2, y2],
        integerOrderAcross: null, source: 'manual', editId: edit.id
      });
    }
    if (edit.action === 'remove-cut' && edit.edge) {
      const [x1, y1, x2, y2] = edit.edge;
      const k = edges.findIndex(
        (e) => e.a[0] === x1 && e.a[1] === y1 && e.b[0] === x2 && e.b[1] === y2
      );
      if (k >= 0) edges.splice(k, 1);
    }
  }

  const unbalanced: [number, number][] = [];
  positives.forEach((p, i) => { if (!usedP.has(i)) unbalanced.push([p.x, p.y]); });
  negatives.forEach((n, i) => { if (!usedN.has(i)) unbalanced.push([n.x, n.y]); });

  // 人工删除可能打破配平：统计每条切口端点覆盖的残差
  const covered = new Set<string>();
  for (const e of edges) {
    for (const [x, y] of [e.a, e.b]) covered.add(`${x},${y}`);
  }
  const extra: [number, number][] = [];
  for (const [x, y] of [...residues.positiveResidues, ...residues.negativeResidues]) {
    if (!covered.has(`${x},${y}`)) extra.push([x, y]);
  }
  const allUnbalanced = dedupPoints([...unbalanced, ...extra]);

  return {
    kind: 'CutNetwork', id: '', provenance, edges,
    unbalancedResidues: allUnbalanced,
    balanced: allUnbalanced.length === 0
  };
}

function dedupPoints(points: [number, number][]): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const [x, y] of points) {
    const k = `${x},${y}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push([x, y]);
    }
  }
  return out;
}
