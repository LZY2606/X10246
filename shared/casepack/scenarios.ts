/**
 * “干涉条纹簿：相位展开、支路切口与光学标定分支”专用离线案例包场景定义。
 * 每个反例情形提供一个最小输入（minimal）与一个组合输入（combined）；
 * 共享原始片段（基线 7 类输入）只存一份不可变内容。
 */
import type { SampleOptions } from '../schema/samples.js';

export type ScenarioKey =
  | 'phase_branch_boundary'
  | 'low_amplitude_hole'
  | 'multiply_connected'
  | 'open_cycle'
  | 'wavelength_revision'
  | 'integer_ambiguity'
  | 'local_lock_conflict';

export interface ScenarioDef {
  key: ScenarioKey;
  title: string;
  domainRule: string;
  /** 最小输入：只触发该情形 */
  minimal: SampleOptions;
  /** 组合输入：与其它边界情形叠加 */
  combined: SampleOptions;
  /** 该情形期望被检验的机器判断规则 */
  expectedRules: string[];
}

const GRID = { width: 14, height: 14, seed: 20260924, kx: 0.42, ky: 0.28, saddle: 0 };

export const SCENARIOS: ScenarioDef[] = [
  {
    key: 'phase_branch_boundary',
    title: '相位跨越 ±π 边界',
    domainRule: '跨越包裹边界的相邻像素必须通过整周增量正确连接，不能误判为大跳变',
    minimal: { ...GRID, kx: 0.62, wrapSeams: [[7, 7]] },
    combined: {
      ...GRID,
      kx: 0.62,
      wrapSeams: [[7, 7], [3, 9]],
      holes: [{ u0: 10, v0: 1, u1: 12, v1: 3 }],
      residueDipoles: [{ u: 5, v: 10, sign: 1 }]
    },
    expectedRules: ['low_amplitude_must_not_guess_phase', 'integer_offsets_across_cuts_must_be_explicit']
  },
  {
    key: 'low_amplitude_hole',
    title: '低振幅孔洞不得猜相位',
    domainRule: '振幅低于阈值的像素信噪不足：质量=null、不展开、切口整周不猜',
    minimal: { ...GRID, holes: [{ u0: 5, v0: 5, u1: 8, v1: 8 }] },
    combined: {
      ...GRID,
      holes: [
        { u0: 5, v0: 5, u1: 8, v1: 8 },
        { u0: 1, v0: 10, u1: 3, v1: 12 }
      ],
      residueDipoles: [{ u: 10, v: 3, sign: -1 as const }]
    },
    expectedRules: ['low_amplitude_must_not_guess_phase']
  },
  {
    key: 'multiply_connected',
    title: '多连通区（遮罩隔断）',
    domainRule: '无效遮罩把域切成多块时，各块独立成树；不允许跨遮罩传播整周',
    minimal: { ...GRID, maskBlocks: [{ u0: 0, v0: 6, u1: 13, v1: 7 }] },
    combined: {
      ...GRID,
      maskBlocks: [
        { u0: 0, v0: 6, u1: 13, v1: 6 },
        { u0: 6, v0: 0, u1: 7, v1: 13 }
      ],
      holes: [{ u0: 10, v0: 10, u1: 12, v1: 12 }]
    },
    expectedRules: ['multiple_trees_are_locally_consistent_keep_paths_and_cycle_residuals']
  },
  {
    key: 'open_cycle',
    title: '循环不闭合（残差）',
    domainRule: '绕行闭合环的缠绕和非零即循环不闭合，必须保留环路径与整周残差',
    minimal: {
      ...GRID,
      residueDipoles: [
        { u: 4, v: 4, sign: 1 },
        { u: 9, v: 9, sign: -1 }
      ]
    },
    combined: {
      ...GRID,
      residueDipoles: [
        { u: 4, v: 4, sign: 1 },
        { u: 9, v: 9, sign: -1 },
        { u: 11, v: 2, sign: 1 }
      ],
      holes: [{ u0: 1, v: 1, u1: 2, v: 2 }]
    },
    expectedRules: [
      'integer_offsets_across_cuts_must_be_explicit',
      'multiple_trees_are_locally_consistent_keep_paths_and_cycle_residuals'
    ]
  },
  {
    key: 'wavelength_revision',
    title: '波长版本变更',
    domainRule: '波长以新版本+父版本表达；仅使高度链过期，展开结果不受影响',
    minimal: { ...GRID },
    combined: { ...GRID, kx: 0.5, residueDipoles: [{ u: 6, v: 6, sign: 1 }] },
    expectedRules: ['multiple_trees_are_locally_consistent_keep_paths_and_cycle_residuals']
  },
  {
    key: 'integer_ambiguity',
    title: '整周多解',
    domainRule: '无法唯一决定的整周边保留全部合法候选、代价与拒绝原因',
    minimal: {
      ...GRID,
      residueDipoles: [
        { u: 3, v: 3, sign: 1 },
        { u: 3, v: 9, sign: -1 }
      ],
      holes: [{ u0: 9, v0: 9, u1: 11, v1: 11 }]
    },
    combined: {
      ...GRID,
      residueDipoles: [
        { u: 3, v: 3, sign: 1 },
        { u: 10, v: 4, sign: -1 }
      ],
      holes: [{ u0: 9, v0: 9, u1: 12, v1: 12 }],
      maskBlocks: [{ u0: 6, v0: 0, u1: 6, v1: 13 }]
    },
    expectedRules: ['keep_all_legal_integer_candidates_when_not_unique']
  },
  {
    key: 'local_lock_conflict',
    title: '局部锁定冲突',
    domainRule: '同一区域两次不同整周基准的锁定都保留并记录冲突；撤销/解决写入历史',
    minimal: { ...GRID, kx: 0.5, residueDipoles: [{ u: 5, v: 5, sign: 1 }] },
    combined: {
      ...GRID,
      kx: 0.55,
      residueDipoles: [
        { u: 5, v: 5, sign: 1 },
        { u: 9, v: 8, sign: -1 }
      ],
      holes: [{ u0: 1, v0: 11, u1: 3, v1: 12 }]
    },
    expectedRules: ['keep_all_legal_integer_candidates_when_not_unique']
  }
];

/** 初始基线：七类输入完整、不可覆盖；无任何反例扰动 */
export const BASELINE_OPTIONS: SampleOptions = { ...GRID, kx: 0.3, ky: 0.2 };
