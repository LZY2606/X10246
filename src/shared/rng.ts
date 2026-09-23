/** 固定 seed 的确定性随机数（LCG），用于展开树的平局打破。 */
export function seededRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}
