import type {
  CutEdge,
  CutEdit,
  CutNetworkPayload,
  Pixel,
  ResidueMapPayload,
} from '../shared/types.ts';
import { edgeKey } from './grid.ts';

export const CUTS_ALGORITHM = 'branch-cut/v1';

function plaquetteCenter(p: Pixel): [number, number] {
  return [p[0] + 0.5, p[1] + 0.5];
}

/** 两个 plaquette 中心之间的 L 形路径，转成像素间边 */
function pathEdges(from: Pixel, to: Pixel): CutEdge[] {
  const edges: CutEdge[] = [];
  let [r, c] = plaquetteCenter(from);
  const [tr, tc] = plaquetteCenter(to);
  const step = (a: number, b: number) => (a < b ? 1 : -1);
  const pushEdge = (r1: number, c1: number, r2: number, c2: number) => {
    // 边连接相邻像素：取跨越线两侧最近的整数像素
    const a: Pixel = [Math.floor(Math.min(r1, r2)), Math.floor(Math.min(c1, c2))];
    const b: Pixel =
      r1 === r2 ? [a[0], a[1] + 1] : [a[0] + 1, a[1]];
    edges.push({ a, b });
  };
  while (c !== tc) {
    const nc = c + step(c, tc);
    pushEdge(r, c, r, nc);
    c = nc;
  }
  while (r !== tr) {
    const nr = r + step(r, tr);
    pushEdge(r, c, r, nr);
    r = nr;
  }
  return edges;
}

/**
 * 支路切口网络：配对正负残差（最近邻贪心），未配对者连到边界。
 * 相位跨越边界时，切口路径显式延伸到图像边缘。
 * 人工切口编辑（cut_edit_history）在此基础上应用。
 */
export function buildCutNetwork(
  residue: ResidueMapPayload,
  rows: number,
  cols: number,
  manualEdits: CutEdit[],
): CutNetworkPayload {
  const positives = residue.cycles.filter((cy) => cy.residual > 0).map((cy) => cy.plaquette);
  const negatives = residue.cycles.filter((cy) => cy.residual < 0).map((cy) => cy.plaquette);
  const cuts: CutEdge[] = [];
  const pairs: CutNetworkPayload['pairs'] = [];
  const remainingNeg = [...negatives];

  for (const pos of positives) {
    if (remainingNeg.length > 0) {
      let best = 0;
      let bestDist = Infinity;
      remainingNeg.forEach((neg, i) => {
        const d = Math.abs(neg[0] - pos[0]) + Math.abs(neg[1] - pos[1]);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      const neg = remainingNeg.splice(best, 1)[0]!;
      pairs.push({ positive: pos, negative: neg });
      cuts.push(...pathEdges(pos, neg));
    } else {
      // 连到最近边界
      const [r, c] = pos;
      const distances: Array<[number, Pixel]> = [
        [r, [-1, c]],
        [rows - 2 - r, [rows - 1, c]],
        [c, [r, -1]],
        [cols - 2 - c, [r, cols - 1]],
      ];
      distances.sort((a, b) => a[0] - b[0]);
      const target = distances[0]![1];
      pairs.push({ positive: pos, negative: 'boundary' });
      const clamped: Pixel = [
        Math.max(0, Math.min(rows - 2, target[0])),
        Math.max(0, Math.min(cols - 2, target[1])),
      ];
      cuts.push(...pathEdges(pos, clamped));
    }
  }

  const seen = new Map<string, CutEdge>();
  for (const e of cuts) seen.set(edgeKey(e.a, e.b), e);
  for (const edit of manualEdits) {
    const key = edgeKey(edit.edge.a, edit.edge.b);
    if (edit.op === 'add') seen.set(key, { a: edit.edge.a, b: edit.edge.b });
    else seen.delete(key);
  }
  return { cuts: [...seen.values()], pairs, manualEdits };
}
