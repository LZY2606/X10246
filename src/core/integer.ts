import type { IntegerCandidate, PixelEdge } from "./types";
import { edgeKey } from "./cuts";

export const INTEGER_ALGO = { algorithmName: "integer-offset-candidates", algorithmVersion: "1.0.0" } as const;

export interface IntegerAmbiguityEdge extends PixelEdge {
  /** 跨边包裹相位差（rad）。 */
  observedJump: number;
  /** 是否低证据（低振幅/低 SNR），无法唯一决定。 */
  lowEvidence: boolean;
}

/**
 * 切口两侧的整周偏移必须显式表示。
 * 低证据切口：保留全部合法候选 wrapOffset ∈ {k-1, k, k+1}（默认 -1,0,+1），
 * 均标记为 legal、adopted=false，进入 unresolvedEdges 等待人工裁定；
 * 高证据切口：唯一采纳最接近观测跳变的整周数，其余候选记录拒绝原因。
 */
export function buildIntegerCandidates(edges: IntegerAmbiguityEdge[]): {
  candidates: IntegerCandidate[];
  unresolvedEdges: PixelEdge[];
} {
  const candidates: IntegerCandidate[] = [];
  const unresolved: PixelEdge[] = [];
  for (const e of edges) {
    const baseK = Math.round(e.observedJump / (2 * Math.PI));
    const options = [baseK - 1, baseK, baseK + 1];
    if (e.lowEvidence) {
      unresolved.push({ a: e.a, b: e.b });
      for (const k of options) {
        candidates.push({
          candidateId: `cand_${edgeKey({ a: e.a, b: e.b })}_k${k}`,
          edge: { a: e.a, b: e.b },
          wrapOffset: k,
          adopted: false,
          legal: true,
          evidence: `LOW_EVIDENCE: 观测跳变 ${e.observedJump.toFixed(3)} rad，切口两侧数据不足，k=${k} 与证据相容`,
          rejectionReason: null,
        });
      }
    } else {
      for (const k of options) {
        const residual = Math.abs(e.observedJump - 2 * Math.PI * k);
        candidates.push({
          candidateId: `cand_${edgeKey({ a: e.a, b: e.b })}_k${k}`,
          edge: { a: e.a, b: e.b },
          wrapOffset: k,
          adopted: k === baseK,
          legal: true,
          evidence: `观测跳变 ${e.observedJump.toFixed(3)} rad，k=${k} 残差 ${residual.toFixed(4)}`,
          rejectionReason: k === baseK ? null : `残差 ${residual.toFixed(4)} rad 大于最小整周解，被自动拒绝`,
        });
      }
    }
  }
  return { candidates, unresolvedEdges: unresolved };
}
