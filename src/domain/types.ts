/**
 * 干涉条纹簿 · 领域数据契约
 * ---------------------------------------------------------------
 * 本文件只使用干涉测量领域自身的词汇，不把领域量压成 name/value。
 * 每个物理量都携带 unit（单位）与 coordinateBasis（坐标基准）。
 *
 * 三类实体：
 *  - RAW       原始输入实体：一经提交不可覆盖，修订以新版本 + 父版本表达
 *  - DERIVED   派生实体：带 algorithmVersion / parameterFingerprint / sources
 *  - REVIEW    复核实体：局部锁定、人工决定等，同样是不可变事件
 */

export type EntityClass = 'RAW' | 'DERIVED' | 'REVIEW';

/** 领域实体种类 —— 名称即领域词汇 */
export type EntityKind =
  // —— 原始输入（七类，均不可覆盖）——
  | 'wrapped_phase_frame'      // 原相位像素（包裹相位，主值区间）
  | 'amplitude_frame'          // 振幅
  | 'snr_score_frame'          // 信噪评分
  | 'validity_mask'            // 无效遮罩
  | 'wavelength_spec'          // 波长
  | 'illumination_geometry'    // 入射几何
  | 'calibration_plane'        // 标定面
  | 'cut_edit_history'         // 切口编辑历史
  // —— 派生层（规范化后的计算结果，可过期但不被覆盖）——
  | 'quality_map'              // 质量图
  | 'residue_map'              // 残差点（极/偶极子）图
  | 'branch_cut_network'       // 支路切口网络
  | 'unwrapping_tree'          // 展开树（路径）
  | 'cut_edge_offset_table'    // 切口两侧整周偏移（显式 2πk）
  | 'unwrapped_phase_surface'  // 展开相位表面
  | 'cycle_residual_table'     // 循环残差表
  | 'height_conversion_chain'; // 高度转换链

/** 复核实体种类 */
export type ReviewKind =
  | 'candidate_set'            // 整周多解候选集
  | 'local_lock'               // 局部解读锁定
  | 'archive_case';            // 反例档案条目

export type AnyKind = EntityKind | ReviewKind;

/** 坐标基准：每个格网都说明自己在哪个像素坐标系里 */
export interface CoordinateBasis {
  type: 'pixel_ij';
  rows: number;
  cols: number;
  origin: 'top-left';
  order: 'row-major';
  /** 可选物理像素节距，用于标定换算；保留原始表示 */
  pixelPitch?: { value: number; unit: string };
}

/** 带单位的格网；values 始终保持导入时的原始表示（派生层才规范化） */
export interface Grid {
  values: number[];
  unit: string;               // 例：'rad','dimensionless','dB','count','nm'
  coordinateBasis: CoordinateBasis;
  /** 导入时保留的原始编码信息 */
  encoding: 'float64' | 'int32' | 'mask' | 'record';
}

/** 无效遮罩单元 */
export type MaskCell = 'valid' | 'invalid' | 'low_amplitude_hole';

/** 波长（含版本，波长版本变更是独立反例情形） */
export interface WavelengthSpec {
  value: number;
  unit: 'nm';
  /** 来源记录，例如计量证书编号 */
  sourceRecord: string;
}

/** 入射几何：入射角场或常量 + 基准说明 */
export interface IlluminationGeometry {
  incidenceAngle: Grid;       // rad，像素坐标系逐像素或常量
  sensitivityVector: { x: number; y: number; z: number };
  basisDescription: string;
}

/** 标定面：相位→高度的标定仿射链参数（保留原始表示） */
export interface CalibrationPlane {
  /** 相位（rad）→ 高度（nm）：h = (phase - phaseOffset) * heightPerRadian + heightOffset */
  heightPerRadian: number;    // nm/rad
  phaseOffset: number;        // rad
  heightOffset: number;       // nm
  referencePlaneDescription: string;
  calibratedFrom: string;     // 标定帧来源记录
}

/** 切口编辑（人工切口的一次不可变编辑） */
export interface CutEdit {
  editId: string;
  action: 'add_cut' | 'remove_cut';
  edge: [number, number];     // 像素对（线性索引）
  atClock: string;            // 虚拟时间 ISO 字符串
  reason: string;
}

/** 包裹相位帧包：一次最小输入所需的全部原始材料 */
export interface InterferogramBundle {
  wrappedPhase: Grid;         // 原相位像素（rad，主值 (-π,π]）
  amplitude: Grid;            // 振幅（count，原始表示）
  snr: Grid;                  // 信噪评分（dB）
  mask: Grid;                 // 无效遮罩（encoding=mask，值映射见 MaskCell）
  wavelength: WavelengthSpec;
  geometry: IlluminationGeometry;
  calibration: CalibrationPlane;
  cutHistory: CutEdit[];      // 切口编辑历史（不可覆盖，追加式）
}

/** 版本引用：任何派生/复核实体都通过“种类+版本号”引用，绝不隐式取最新版 */
export interface VersionRef {
  kind: AnyKind;
  entityId: string;
  version: number;
  /** 冗余内容摘要；读取时核对，不一致即损坏 */
  digest: string;
}

/** 算法来源记录 */
export interface Provenance {
  algorithmVersion: string;       // 例 'unwrap:goldstein-qg@1.0.0'
  parameterFingerprint: string;   // 参数对象的规范化哈希
  sources: VersionRef[];          // 直接来源（不是传递来源）
  parentVersion?: number;         // 同一实体的父版本（修订链）
  /** 派生该版本时回放的事件范围 */
  basedOnEventSeq?: number;
}

export type CandidateStatus = 'legal_undecided' | 'accepted' | 'rejected';

/** 切口边整周候选：2πk 的 k 与拒绝原因均为一等数据 */
export interface IntegerOffsetCandidate {
  k: number;
  status: CandidateStatus;
  /** 拒绝原因；accepted/undecided 时为 null */
  rejectionReason: string | null;
  /** 一致性代价（循环残差平方和），null 表示未知/不可计算 */
  cost: number | null;
  decidedByEventId?: string;
}

/** 循环残差：展开树上路径闭合到边时的残差（单位 2π） */
export interface CycleResidual {
  cycleId: string;
  edges: Array<[number, number]>;
  /** 闭合残差，单位 rad（已按 2π 折算后剩余） */
  residualRad: number | null;
  windingFraction: number | null;
  closed: boolean;                // false = 循环不闭合
  nonClosureReason: string | null;
}

/** 高度转换链的一节点 */
export interface HeightChainNode {
  step: 'wrapped_principal' | 'unwrapped' | 'fringe_order' | 'optical_path' | 'height';
  fromRef?: VersionRef;
  valueSummary: string;
  unit: string;
  transformVersion: string;
  parameterFingerprint: string;
  /** 无法转换的像素留在原位置并附诊断 */
  diagnostics: Array<{ pixel: number; code: string; message: string }>;
}

/** 实体版本的载荷（按 kind 区分） */
export interface EntityPayloadMap {
  wrapped_phase_frame: { grid: Grid };
  amplitude_frame: { grid: Grid };
  snr_score_frame: { grid: Grid };
  validity_mask: { cells: MaskCell[]; coordinateBasis: CoordinateBasis };
  wavelength_spec: WavelengthSpec;
  illumination_geometry: IlluminationGeometry;
  calibration_plane: CalibrationPlane;
  cut_edit_history: { edits: CutEdit[] };
  quality_map: { quality: Grid; lowAmplitudePixels: number[] };
  residue_map: { residues: Array<{ pixel: number; charge: 1 | -1 }> };
  branch_cut_network: { cutEdges: Array<[number, number]>; dipolePairs: Array<[number, number]>; balanced: boolean };
  unwrapping_tree: { parentEdge: Record<number, [number, number] | null>; root: number; regions: number[][]; paths: Record<string, number[]> };
  cut_edge_offset_table: {
    edge: [number, number];
    candidates: IntegerOffsetCandidate[];
    note: string;
  }[];
  unwrapped_phase_surface: {
    unwrapped: Grid;
    /** 无猜测像素：低振幅/无效孔洞保持 unknown，不插值 */
    unknownPixels: number[];
    treeRef: VersionRef;
  };
  cycle_residual_table: { cycles: CycleResidual[] };
  height_conversion_chain: { nodes: HeightChainNode[]; height?: Grid };
  candidate_set: {
    subjectRef: VersionRef;
    candidates: IntegerOffsetCandidate[];
    ambiguity: 'unique' | 'multiple';
  };
  local_lock: {
    targetRef: VersionRef;
    scopePixels: number[];
    chosenCandidateK: number | null;
    locked: boolean;
    conflicts: Array<{ lockEventId: string; reason: string }>;
  };
  archive_case: {
    situation: CounterexampleSituation;
    baselineDigest: string;
    changedDirectSource: VersionRef | null;
    influenceScope: string[];
    adopted: boolean;
    judgmentEventIds: string[];
  };
}

/** 七种反例情形 + 组合情形 */
export type CounterexampleSituation =
  | 'wrap_boundary_crossing'   // 相位跨越边界
  | 'low_amplitude_hole'      // 低振幅孔洞
  | 'multiconnected_region'   // 多连通区
  | 'cycle_nonclosure'        // 循环不闭合
  | 'wavelength_version_change' // 波长版本变更
  | 'integer_ambiguity'       // 整周多解
  | 'local_lock_conflict'     // 局部锁定冲突
  | 'combined';               // 组合输入

/** 机器可读取的判定事件依据 */
export interface MachineJudgment {
  rule: string;                 // 机器可读规则码
  holds: boolean | null;        // null = 无法唯一决定
  evidence: Record<string, unknown>;
}

/** 事件类型 */
export type EventType =
  | 'project_created'
  | 'raw_committed'             // 原始材料提交（不可覆盖）
  | 'raw_revised'               // 原始材料修订（新版本+父版本）
  | 'derivation_computed'       // 派生版本产生
  | 'derivation_staled'         // 直接来源变化 → 标记过期（仅状态，不覆盖）
  | 'candidate_proposed'
  | 'candidate_accepted'
  | 'candidate_rejected'
  | 'decision_accept'           // 人工接受
  | 'decision_reject'           // 人工否定
  | 'decision_param_adjust'     // 参数调整
  | 'cut_edit_applied'
  | 'lock_acquired'
  | 'lock_conflict'
  | 'lock_released'
  | 'archive_judgment'
  | 'project_exported'
  | 'project_imported';

export interface LedgerEvent {
  seq: number;
  eventId: string;
  clock: string;
  type: EventType;
  entityKind?: AnyKind;
  entityId?: string;
  version?: number;
  payload: Record<string, unknown>;
  /** 机器可读判定（反例档案规则） */
  judgments?: MachineJudgment[];
  /** 该事件直接依赖的版本引用 */
  refs: VersionRef[];
  parentEventId: string | null;
}
