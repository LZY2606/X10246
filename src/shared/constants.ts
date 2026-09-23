export const ALGORITHM_VERSIONS = {
  residue: "residue-2x2/v1.0.0",
  branchCut: "branch-cut-nearest-pairing/v1.0.0",
  quality: "quality-weighted/v1.0.0",
  unwrap: "priority-flood-tree/v1.0.0",
  cycle: "cycle-residual-integral/v1.0.0",
  height: "height-sensitivity-chain/v1.0.0",
} as const;

export const FIXED_SEED = 20260919;
export const TWO_PI = Math.PI * 2;

export const RULES = {
  noGuessLowAmplitude:
    "低振幅区域不得猜相位：像素保持未知并记录原因，禁止插值填补。",
  explicitCutOffset:
    "切口两侧的整周偏移必须显式表示；无法判定时为 null 并附诊断。",
  treeConsistency:
    "不同展开树可得到局部一致解；必须保留树路径与循环残差。",
  allLegalCandidates:
    "整周无法唯一决定时保留全部合法候选，标记采纳/拒绝理由。",
} as const;
