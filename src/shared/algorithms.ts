// 算法版本：派生值必须携带，规则修订产生新版本而不是覆盖旧结果。
export const ALGO = {
  residue: "residue/goldstein-1.0.0",
  quality: "quality/snr-residue-1.0.0",
  branchcut: "branchcut/nearest-charge-1.0.0",
  unwrap: "unwrap/quality-guided-tree-1.0.0",
  candidates: "candidates/loop-consistent-1.0.0",
  height: "height/sensitivity-calib-1.0.0",
} as const;

export interface UnwrapParams {
  lowAmplitudeSnrThreshold: number;
  forbidGuessUnknown: boolean;
  respectBranchCuts: boolean;
  maxCandidateK: number;
}

export const DEFAULT_UNWRAP_PARAMS: UnwrapParams = {
  lowAmplitudeSnrThreshold: 0.25,
  forbidGuessUnknown: true,
  respectBranchCuts: true,
  maxCandidateK: 3,
};
