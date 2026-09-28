/**
 * 干涉条纹簿 —— 领域数据契约
 *
 * 设计原则：
 * - 直接使用本领域词汇（包裹相位、整周候选、支路切口、循环残差…），不压成 name/value。
 * - 所有领域量携带单位或坐标基准；原始表示在 raw 层保留，规范化只发生在派生层。
 * - 原相位像素、信噪评分、无效遮罩、波长、入射几何、标定面、切口编辑历史均不可覆盖。
 * - 每个实体版本、每条记录、每个显示值都有稳定身份（stableId），导出/删除/再导入后保持。
 */

export type UnitName =
  | 'radian_wrapped'   // 包裹相位，范围 (-π, π]
  | 'radian'           // 展开相位（连续，单位 rad）
  | 'nanometer'        // 波长/高度
  | 'micrometer'
  | 'millimeter'
  | 'meter'
  | 'degree'           // 入射角
  | 'adimensional'     // 信噪比、0..1 评分
  | 'fringe_order';    // 整周序数 k

/** 坐标基准：像素格点使用图像坐标 (col,row)=(x,y)，原点在左上；物理坐标由标定面给出。 */
export interface CoordBasis {
  kind: 'pixel_image' | 'physical_calibrated';
  origin: 'top_left';
  /** 每个栅格步对应的物理位移与单位；pixel_image 时为像素。 */
  pitchX?: Qty;
  pitchY?: Qty;
}

export interface Qty {
  value: number;
  unit: UnitName;
}

/** 栅格上的量；flat 长度恒为 width*height。缺失值用 null，不用猜测填充。 */
export interface Grid {
  width: number;
  height: number;
  unit: UnitName;
  basis: CoordBasis;
  /** 原表示逐像素保留；无法转换的值保持 null 并在诊断里说明。 */
  values: (number | null)[];
}

export type EntityKind =
  | 'wrapped_phase_frame'      // 原相位像素（不可变输入）
  | 'amplitude_frame'          // 振幅/强度（不可变输入）
  | 'quality_score_frame'      // 信噪评分（不可变输入；可随导入从振幅派生一次）
  | 'invalid_mask'             // 无效遮罩（不可变输入）
  | 'wavelength'               // 波长（不可变输入，修订=新版本+父版本）
  | 'illumination_geometry'    // 入射几何（不可变输入）
  | 'calibration_plane'        // 标定面（不可变输入）
  | 'cut_edit_record'          // 切口编辑历史（不可变追加）
  | 'residue_map'              // 残差点图（派生）
  | 'branch_cut_network'       // 支路切口网络（派生+人工切口）
  | 'quality_map'              // 质量图（派生）
  | 'unwrap_tree'              // 展开树（路径）（派生）
  | 'integer_offset_field'     // 整周序数场 k（派生）
  | 'unwrapped_phase_field'    // 展开相位场（派生）
  | 'cycle_residual_ledger'    // 循环残差账（派生）
  | 'height_chain'             // 高度转换链（派生）
  | 'lock_decision'            // 局部锁定/接受/否定（人工决定）
  | 'archive_verdict';         // 反例档案判定事件（机器可读）

export type InputKind = Extract<
  EntityKind,
  | 'wrapped_phase_frame' | 'amplitude_frame' | 'quality_score_frame'
  | 'invalid_mask' | 'wavelength' | 'illumination_geometry'
  | 'calibration_plane' | 'cut_edit_record'
>;

export type DerivedKind = Exclude<
  EntityKind,
  InputKind | 'lock_decision' | 'archive_verdict'
>;

/** 直接来源：引用必须给出版本号与内容摘要；缺失引用即损坏，不允许退回“最新版”。 */
export interface SourceRef {
  entityId: string;
  version: number;
  contentHash: string;
  role: string;
}

export interface AlgorithmFingerprint {
  algorithmId: string;
  algorithmVersion: string;
  paramFingerprint: string;
  params: Record<string, unknown>;
}

/**
 * 实体版本。身份规则：
 * - entityId：逻辑实体的稳定身份（导出再导入保持）。
 * - version：同一逻辑实体的版本序号，从 1 起。
 * - versionId：版本的稳定身份 `entityId#v<version>`。
 * - contentHash：规范内容哈希；导入校验。
 */
export interface EntityVersion<K extends EntityKind = EntityKind, P = unknown> {
  entityId: string;
  version: number;
  parentVersion: number | null;
  kind: K;
  contentHash: string;
  createdAt: number;            // 虚拟时间注入，便于固定 seed 重放
  immutable: boolean;          // 输入恒为 true
  directSources: SourceRef[];
  algorithm?: AlgorithmFingerprint;
  payload: P;
  /** 派生版本的时效标记：其某条来源被更新版本取代时置 true；仍可查看但不冒充当前结果。 */
  superseded?: boolean;
}

/** 显示值的稳定身份：任何画在页面上的数都能被锁定/引用并回溯。 */
export interface DisplayValue<T = number | string> {
  vid: string;                  // stable display value id
  value: T;
  unit?: UnitName | 'boolean' | 'text' | 'candidate_set' | 'diagnostic';
  basis?: CoordBasis;
  /** 该显示值的出处：实体版本 + 路径（如网格下标或字段路径）。 */
  provenance: {
    entityId: string;
    version: number;
    contentHash: string;
    path: string;
  };
  status: 'ok' | 'unknown' | 'unconvertible' | 'rejected' | 'ambiguous' | 'stale';
  note?: string;
}
