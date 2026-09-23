import type { PixelCoord, PixelEdge, BranchCutNetworkPayload, CutEditEntry, ResidueCharge } from "./types";

export const CUT_ALGO = { algorithmName: "goldstein-branch-cut-deterministic", algorithmVersion: "1.0.0" } as const;

export function keyOf(p: PixelCoord): string {
  return `${p.r},${p.c}`;
}

export function edgeKey(e: PixelEdge): string {
  const a = e.a;
  const b = e.b;
  const ka = keyOf(a);
  const kb = keyOf(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function neighbors(p: PixelCoord): PixelCoord[] {
  return [
    { r: p.r - 1, c: p.c },
    { r: p.r, c: p.c + 1 },
    { r: p.r + 1, c: p.c },
    { r: p.r, c: p.c - 1 },
  ];
}

export function manhattan(a: PixelCoord, b: PixelCoord): number {
  return Math.abs(a.r - b.r) + Math.abs(a.c - b.c);
}

/**
 * 确定性 Goldstein 式切口：
 *  - 残荷按扫描序处理；+1 残荷在搜索盒内找 -1 残荷配对，
 *    找不到则连向最近图像边界；
 *  - 同号残荷放入同一平衡盒时再配对；
 *  - 全部选择以扫描序 / 字典序打破平局，结果完全确定。
 * 切口两侧的整周偏移在后续整数候选实体中显式表示。
 */
export function buildCuts(
  residues: Array<{ r: number; c: number; charge: ResidueCharge }>,
  width: number,
  height: number,
  manualCuts: PixelEdge[] = [],
): Omit<BranchCutNetworkPayload, "label"> {
  const links: BranchCutNetworkPayload["residueLinks"] = [];
  const cutSet = new Map<string, PixelEdge>();
  const remaining = residues.map((x) => ({ ...x }));

  const addEdge = (a: PixelCoord, b: PixelCoord) => {
    const e = { a: { ...a }, b: { ...b } };
    cutSet.set(edgeKey(e), e);
  };
  const drawLine = (from: PixelCoord, to: PixelCoord) => {
    let cur = { ...from };
    let guard = 0;
    while ((cur.r !== to.r || cur.c !== to.c) && guard < 10000) {
      const options = neighbors(cur).filter((p) => manhattan(p, to) < manhattan(cur, to));
      options.sort((x, y) => keyOf(x).localeCompare(keyOf(y)));
      const nxt = options[0];
      if (!nxt) break;
      addEdge(cur, nxt);
      cur = nxt;
      guard++;
    }
  };
  const borderOf = (p: PixelCoord): PixelCoord => {
    const d = [p.r, height - 1 - p.r, p.c, width - 1 - p.c];
    const m = Math.min(...d);
    if (m === p.r) return { r: 0, c: p.c };
    if (m === height - 1 - p.r) return { r: height - 1, c: p.c };
    if (m === p.c) return { r: p.r, c: 0 };
    return { r: p.r, c: width - 1 };
  };

  const used = new Set<number>();
  for (let i = 0; i < remaining.length; i++) {
    if (used.has(i)) continue;
    const cur = remaining[i] as { r: number; c: number; charge: ResidueCharge };
    if (cur.charge !== 1) continue;
    let bestJ = -1;
    let bestD = Infinity;
    for (let j = 0; j < remaining.length; j++) {
      if (used.has(j) || j === i) continue;
      const o = remaining[j] as { r: number; c: number; charge: ResidueCharge };
      if (o.charge !== -1) continue;
      const d = manhattan(cur, o);
      if (d < bestD || (d === bestD && j < bestJ)) {
        bestD = d;
        bestJ = j;
      }
    }
    if (bestJ >= 0) {
      const o = remaining[bestJ] as PixelCoord;
      drawLine(cur, o);
      links.push({ from: cur, to: o, charge: 1 });
      used.add(i);
      used.add(bestJ);
    } else {
      const border = borderOf(cur);
      drawLine(cur, border);
      links.push({ from: cur, to: "image-border", charge: 1 });
      used.add(i);
    }
  }
  // 未配对的孤立 -1 残荷连边界。
  for (let j = 0; j < remaining.length; j++) {
    if (used.has(j)) continue;
    const cur = remaining[j] as { r: number; c: number; charge: ResidueCharge };
    const border = borderOf(cur);
    drawLine(cur, border);
    links.push({ from: cur, to: "image-border", charge: cur.charge });
    used.add(j);
  }

  for (const m of manualCuts) cutSet.set(edgeKey(m), m);
  const cuts = [...cutSet.values()].sort((x, y) => edgeKey(x).localeCompare(edgeKey(y)));
  return {
    cuts,
    residueLinks: links,
    source: manualCuts.length > 0 && residues.length > 0 ? "auto+manual" : manualCuts.length > 0 ? "manual-edit" : "goldstein-deterministic",
  };
}

export function applyCutEdits(base: PixelEdge[], history: CutEditEntry[]): PixelEdge[] {
  const set = new Map<string, PixelEdge>();
  for (const e of base) set.set(edgeKey(e), e);
  for (const entry of history) {
    if (entry.type === "addCut") set.set(edgeKey(entry.edge), entry.edge);
    if (entry.type === "removeCut") set.delete(edgeKey(entry.edge));
  }
  return [...set.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
}
