import { integrateK } from './unwraptree';
import type {
  CalibrationPlane,
  CutNetwork,
  GridDatum,
  IntegerCandidate,
  IntegerCandidateSet,
  UnwrapTree,
  WrappedPhaseFrame,
} from '../domain/types';

export const CANDIDATE_ALGO_VERSION = 'candidate/v1';

export interface CandidateParams {
  /** 无锚点时保留的整周候选范围（整周多解）。 */
  globalOffsets: number[];
}

export const DEFAULT_CANDIDATE_PARAMS: CandidateParams = { globalOffsets: [-1, 0, 1] };

/**
 * 整周候选集合：
 * - 每棵展开树给出一个局部一致的相对整周场（component 内）；
 * - 跨过被切断的多连通区，分量间相对偏移无法由数据唯一决定：
 *   枚举每个分量相对分量 0 的偏移组合（相对分量多解）；
 * - 若标定锚点存在，用锚点像素所在分量的绝对整周销定全局条纹序，
 *   否则保留 globalOffsets 中全部合法全局候选（全局条纹多解）。
 * 无法唯一决定时不挑“看起来对”的一个，而是全部作为 legal 保留。
 */
export function enumerateCandidates(
  phase: WrappedPhaseFrame,
  cuts: CutNetwork,
  trees: UnwrapTree[],
  calibration: CalibrationPlane | null,
  params: CandidateParams = DEFAULT_CANDIDATE_PARAMS
): IntegerCandidateSet {
  const g: GridDatum = phase.grid;
  const perTree = trees.map((t) => ({ tree: t, k: integrateK([t], g) }));
  const anchor = calibration && calibration.anchorPixels.length ? calibration.anchorPixels[0] : null;
  const anchorComponent =
    anchor === null ? null : trees.find((t) => t.pathOrder.includes(anchor))?.componentId ?? null;

  // 分量间相对偏移枚举（多连通 + 切口隔离 => 无法唯一决定）
  const relativeCombos: Record<string, number>[] = enumerateRelative(trees.length, cuts, trees);

  const candidates: IntegerCandidate[] = [];
  let ci = 0;
  for (const rel of relativeCombos) {
    const merged: (number | null)[] = new Array(g.width * g.height).fill(null);
    for (const { tree, k } of perTree) {
      const shift = rel[String(tree.componentId)] ?? 0;
      for (const p of tree.pathOrder) merged[p] = (k[p] as number) + shift;
    }
    if (anchor !== null && anchorComponent !== null) {
      const atAnchor = merged[anchor] ?? 0;
      const pinned = merged.map((v) => (v === null ? null : v - atAnchor));
      candidates.push(
        makeCandidate(ci++, trees[0]?.treeId ?? 'tree-none', pinned, 0, rel, 'none', anchor)
      );
    } else {
      for (const go of params.globalOffsets) {
        const shifted = merged.map((v) => (v === null ? null : v + go));
        candidates.push(
          makeCandidate(
            ci++,
            trees[0]?.treeId ?? 'tree-none',
            shifted,
            go,
            rel,
            trees.length > 1 ? 'relative-component' : 'global-fringe',
            null
          )
        );
      }
    }
  }

  const ambiguity: IntegerCandidateSet['ambiguity'] =
    anchor !== null
      ? candidates.length > 1
        ? 'relative-component'
        : 'none'
      : trees.length > 1
        ? 'relative-component'
        : 'global-fringe';

  return { grid: g, anchor, candidates, ambiguity };
}

function enumerateRelative(
  componentCount: number,
  cuts: CutNetwork,
  trees: UnwrapTree[]
): Record<string, number>[] {
  if (componentCount <= 1) return [{ '0': 0 }];
  // 若两个分量恰好由带显式 jump 的切口边相邻，则相对偏移被 jump 决定；
  // 否则该分量相对偏移未知，枚举 {-1,0,1}，作为合法多解全部保留。
  const nodes = new Map<number, number>();
  for (const t of trees) nodes.set(t.componentId, t.pathOrder[0]);
  void nodes;
  const compOf = new Map<number, number>();
  for (const t of trees) for (const p of t.pathOrder) compOf.set(p, t.componentId);
  const fixed = new Map<string, number>([['0', 0]]);
  for (const cut of cuts.cuts) {
    const ca = compOf.get(cut.a);
    const cb = compOf.get(cut.b);
    if (ca !== undefined && cb !== undefined && ca !== cb) {
      const keyB = String(cb);
      if (!fixed.has(keyB)) fixed.set(keyB, (fixed.get(String(ca)) ?? 0) + cut.jump);
    }
  }
  const unknown: number[] = [];
  for (let c = 1; c < componentCount; c++) {
    if (!fixed.has(String(c))) unknown.push(c);
  }
  const combos: Record<string, number>[] = [];
  const choices = [-1, 0, 1];
  const recurse = (i: number, acc: Record<string, number>) => {
    if (i === unknown.length) {
      combos.push({ ...acc });
      return;
    }
    for (const ch of choices) {
      acc[String(unknown[i])] = ch;
      recurse(i + 1, acc);
    }
  };
  recurse(0, Object.fromEntries(fixed));
  return combos;
}

function makeCandidate(
  i: number,
  treeId: string,
  k: (number | null)[],
  globalOffset: number,
  componentOffsets: Record<string, number>,
  ambiguity: IntegerCandidateSet['ambiguity'],
  anchor: number | null
): IntegerCandidate {
  return {
    candidateId: `cand-${i.toString().padStart(2, '0')}`,
    treeId,
    k,
    globalOffset,
    componentOffsets,
    status: 'legal',
    score: 0,
    ambiguityNote:
      ambiguity === 'none'
        ? anchor === null
          ? undefined
          : 'pinned by calibration anchor'
        : ambiguity === 'global-fringe'
          ? 'global fringe order unobservable without anchor'
          : 'relative offset across disconnected regions unobservable',
  };
}
