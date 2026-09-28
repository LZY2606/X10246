import type {
  CutEdge,
  CutEdit,
  Residue,
} from '../shared/model.js';

/**
 * 支路切口放置（Goldstein 最近邻配对的确定性变体）。
 * 同号残差或配不到对的残差 -> 引到最近边界（dipole to boundary）。
 * 异号最近邻 -> 直接连接。
 *
 * 输出的切口边是“被切口跨越”的像素邻接边（在展开树中禁止穿越）。
 * 人工切口编辑历史单独保留，这里只生成算法候选切口。
 */
export function placeCuts(
  residues: Residue[],
  rows: number,
  cols: number,
  edgeIdFor: (a: [number, number], b: [number, number]) => string,
): CutEdge[] {
  const used = new Set<string>();
  const edges: CutEdge[] = [];
  const remaining = [...residues];

  // 确定性排序，保证固定 seed 下可复现
  remaining.sort((p, q) => p.at[0] - q.at[0] || p.at[1] - q.at[1]);

  const center = (res: Residue): [number, number] => [res.at[0], res.at[1]];
  const manhattan = (a: [number, number], b: [number, number]) =>
    Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);

  for (let i = 0; i < remaining.length; i++) {
    const r = remaining[i];
    if (used.has(r.residueId)) continue;
    let best: Residue | null = null;
    let bestD = Infinity;
    for (let j = i + 1; j < remaining.length; j++) {
      const s = remaining[j];
      if (used.has(s.residueId)) continue;
      if (s.charge === r.charge) continue; // 只配异号对
      const d = manhattan(center(r), center(s));
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best) {
      used.add(r.residueId);
      used.add(best.residueId);
      edges.push({
        edgeId: edgeIdFor(center(r), center(best)),
        a: center(r),
        b: center(best),
        kind: 'residue-residue',
      });
    } else {
      used.add(r.residueId);
      const [rr, cc] = center(r);
      // 最近边界点
      const boundary: [number, number] = nearestBoundary(rr, cc, rows, cols);
      edges.push({
        edgeId: edgeIdFor(center(r), boundary),
        a: center(r),
        b: boundary,
        boundary: true,
        kind: 'residue-boundary',
      });
    }
  }
  return edges;
}

function nearestBoundary(r: number, c: number, rows: number, cols: number): [number, number] {
  const options: Array<[number, number, number]> = [
    [0, c, r],
    [rows - 1, c, rows - 1 - r],
    [r, 0, c],
    [r, cols - 1, cols - 1 - c],
  ];
  options.sort((a, b) => a[2] - b[2]);
  return [options[0][0], options[0][1]];
}

/** 把人工切口编辑历史折叠为当前生效的切口集合 */
export function applyCutHistory(algorithmCuts: CutEdge[], history: CutEdit[]): CutEdge[] {
  const byId = new Map<string, CutEdge>();
  for (const cut of algorithmCuts) byId.set(cut.edgeId, cut);
  for (const edit of history) {
    if (edit.action === 'clear') {
      byId.clear();
    } else if (edit.action === 'add-cut' && edit.edge) {
      byId.set(edit.edge.edgeId, edit.edge);
    } else if (edit.action === 'remove-cut' && edit.edge) {
      byId.delete(edit.edge.edgeId);
    }
  }
  return [...byId.values()];
}

/** 切口是否跨越像素邻接边 (u<->v)。用线段光栅化把残差-残差连线落到网格边上。 */
export function cutBlocksEdge(
  cuts: CutEdge[],
  u: [number, number],
  v: [number, number],
): string | null {
  const key = (a: [number, number], b: [number, number]) =>
    [a, b].map((p) => p.join(',')).sort().join('|');
  const want = key(u, v);
  for (const cut of cuts) {
    for (const segment of rasterize(cut.a, cut.b)) {
      if (key(segment[0], segment[1]) === want) return cut.edgeId;
    }
  }
  return null;
}

/** 把两点连线分解为相邻像素边（曼哈顿步进，确定性） */
function rasterize(a: [number, number], b: [number, number]): Array<[[number, number], [number, number]]> {
  let [r, c] = a;
  const [tr, tc] = b;
  const out: Array<[[number, number], [number, number]]> = [];
  while (r !== tr || c !== tc) {
    const nr = r + Math.sign(tr - r);
    const nc = c + Math.sign(tc - c);
    if (r !== tr) {
      out.push([[r, c], [nr, c]]);
      r = nr;
    } else {
      out.push([[r, c], [r, nc]]);
      c = nc;
    }
  }
  return out;
}
