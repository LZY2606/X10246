import { bitAt, makeFragment, type GridFragment } from "./grid";
import type { ForestEdge, PixelCoord, PixelEdge, UnwrapForestPayload } from "./types";
import { edgeKey, keyOf } from "./cuts";

export const UNWRAP_ALGO = { algorithmName: "flood-fill-unwrap-forest", algorithmVersion: "1.0.0" } as const;

const TOL = 1e-9;

function wrapDelta(a: number, b: number): number {
  let d = b - a;
  while (d <= -Math.PI) d += 2 * Math.PI;
  while (d > Math.PI) d -= 2 * Math.PI;
  return d;
}

function neighbors4(p: PixelCoord): PixelCoord[] {
  return [
    { r: p.r - 1, c: p.c },
    { r: p.r, c: p.c + 1 },
    { r: p.r + 1, c: p.c },
    { r: p.r, c: p.c - 1 },
  ];
}

export interface UnwrapResult {
  payload: Omit<UnwrapForestPayload, "label">;
  phaseFragment: GridFragment;
  unknownFragment: GridFragment;
}

/**
 * 在“有效像素且非切口边”构成的图上做确定性 BFS 展开：
 *  - 每个连通分量得到一棵展开树（不同树可给出局部一致解）；
 *  - 低振幅/无效像素保持未知，绝不猜；
 *  - 保留每条树边使用的 wrapCount 与原始包裹增量（路径可审）；
 *  - 锚点取扫描序首个有效像素，锚点整周数为 0。
 */
export function unwrap(phase: GridFragment, valid: GridFragment, cuts: PixelEdge[]): UnwrapResult {
  const w = phase.width;
  const h = phase.height;
  const cutSet = new Set(cuts.map(edgeKey));
  const visited = bits(w, h, () => 0);
  const comps: UnwrapForestPayload["components"] = [];
  const unwrapped = new Float64Array(w * h);
  const unknownData: string[] = new Array(w * h).fill("0");
  const phaseAt = (r: number, c: number) => (phase.data as number[])[r * w + c] as number;

  const allPixels: PixelCoord[] = [];
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) allPixels.push({ r, c });

  let compIndex = 0;
  for (const start of allPixels) {
    if (bitAt(visited, start.r, start.c) === 1 || bitAt(valid, start.r, start.c) === 0) continue;
    const compId = `comp_${compIndex++}`;
    const queue: PixelCoord[] = [start];
    const visitedSet = new Set<string>([keyOf(start)]);
    const edges: ForestEdge[] = [];
    const pixels: PixelCoord[] = [];
    unwrapped[start.r * w + start.c] = phaseAt(start.r, start.c);
    while (queue.length > 0) {
      const cur = queue.shift() as PixelCoord;
      pixels.push(cur);
      const vi = cur.r * w + cur.c;
      (visited.data as string);
      visited.data = setBit(visited.data as string, w, cur.r, cur.c, "1");
      const opts = neighbors4(cur)
        .filter(
          (n) =>
            n.r >= 0 && n.c >= 0 && n.r < h && n.c < w &&
            bitAt(valid, n.r, n.c) === 1 &&
            !visitedSet.has(keyOf(n)) &&
            !cutSet.has(edgeKey({ a: cur, b: n })),
        )
        .sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
      for (const n of opts) {
        visitedSet.add(keyOf(n));
        const d = wrapDelta(phaseAt(cur.r, cur.c), phaseAt(n.r, n.c));
        const rawInc = phaseAt(n.r, n.c) - phaseAt(cur.r, cur.c);
        let wrapCount = 0;
        let adj = rawInc;
        while (adj - d > TOL) {
          adj -= 2 * Math.PI;
          wrapCount -= 1;
        }
        while (adj - d < -TOL) {
          adj += 2 * Math.PI;
          wrapCount += 1;
        }
        unwrapped[n.r * w + n.c] = unwrapped[vi] as number + d;
        edges.push({ parent: { ...cur }, child: { ...n }, wrapCount, wrappedIncrement: Number(rawInc.toFixed(12)) });
        queue.push(n);
      }
    }
    comps.push({ componentId: compId, anchor: { ...start }, pixels: pixels.sort((a, b) => keyOf(a).localeCompare(keyOf(b))), edges });
  }

  for (let i = 0; i < w * h; i++) {
    const r = Math.floor(i / w);
    const c = i % w;
    if (bitAt(valid, r, c) === 0) {
      unknownData[i] = "1";
    }
  }

  const phaseFrag = makeFragment("f64", w, h, Array.from(unwrapped));
  const unknownFrag = makeFragment("bits", w, h, unknownData.join(""));
  return {
    payload: {
      width: w,
      height: h,
      components: comps,
      unwrappedPhase: { kind: "gridFragment", fragmentId: phaseFrag.fragmentId, encoding: phaseFrag.encoding, width: phaseFrag.width, height: phaseFrag.height, digest: phaseFrag.digest },
      unknownBits: { kind: "gridFragment", fragmentId: unknownFrag.fragmentId, encoding: unknownFrag.encoding, width: unknownFrag.width, height: unknownFrag.height, digest: unknownFrag.digest },
    },
    phaseFragment: phaseFrag,
    unknownFragment: unknownFrag,
  };
}

function setBit(s: string, width: number, r: number, c: number, val: "0" | "1"): string {
  const i = r * width + c;
  return s.substring(0, i) + val + s.substring(i + 1);
}
