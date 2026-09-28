import type { Diagnostic, Quantity, CoordFrame } from './units.js';
import type { Grid } from './grid.js';

/* ------------------------------------------------------------------ */
/* 输入实体：原相位像素 / 信噪评分 / 无效遮罩 / 波长 / 入射几何 /        */
/* 标定面 / 切口编辑历史 —— 一经提交不可覆盖，修订 = 新版本 + 父版本。   */
/* ------------------------------------------------------------------ */

export type RawFrameKind = 'wrapped-phase' | 'amplitude' | 'quality' | 'mask' | 'calibration-frame';

export interface RawFrameContent {
  kind: RawFrameKind;
  grid: Grid;
  unit: Quantity['unit'];          // rad | count | 1 ...
  frame: CoordFrame;               // 坐标基准，导入时原样保留
  rawRepresentation: string;       // 原始表示（如仪器导出的文本头），不可覆盖
  note?: string;
}

export interface WavelengthContent {
  lambda: Quantity;                // 例如 { value: 632.8, unit: 'nm' }
  source: string;                  // 激光器/标定证书编号
}

export interface IlluminationGeometryContent {
  thetaI: Quantity;                // 入射角（rad 或 deg）
  thetaO: Quantity;                // 观测角
  pixelPitch?: Quantity;           // 传感器像素间距，缺失时物理坐标换算会出诊断
}

export interface CalibrationPlaneContent {
  // h_corr = h - (a*x + b*y + c)，系数单位与坐标基准显式携带
  a: Quantity; b: Quantity; c: Quantity;
  frame: CoordFrame;
  measuredFrom: string;            // 标定帧来源引用
}

export interface CutSegment { a: { row: number; col: number }; b: { row: number; col: number }; }

export interface CutEdit {
  editId: string;
  action: 'add' | 'remove';
  segments: CutSegment[];
  reason: string;
}

/* ------------------------------------------------------------------ */
/* 决定实体：低振幅不猜相位 / 切口两侧整周偏移显式 / 保留路径与循环残差 */
/* ------------------------------------------------------------------ */

export type JudgementRuleId =
  | 'RULE_NO_GUESS_LOW_AMPLITUDE'    // 低振幅区域不得猜相位
  | 'RULE_EXPLICIT_CUT_OFFSET'       // 切口两侧的整周偏移要显式表示
  | 'RULE_KEEP_PATH_AND_RESIDUAL';   // 不同展开树可得到局部一致解，需保留路径与循环残差

/* ------------------------------------------------------------------ */
/* 事件流：一切状态变化的唯一来源                                       */
/* ------------------------------------------------------------------ */

export type EventType =
  | 'PROJECT_CREATED'
  | 'RAW_FRAME_SUBMITTED'        // 原相位像素/信噪评分/无效遮罩等不可覆盖输入
  | 'WAVELENGTH_SUBMITTED'
  | 'GEOMETRY_SUBMITTED'
  | 'CALIBRATION_SUBMITTED'
  | 'CUT_EDIT_APPENDED'          // 切口编辑历史：只追加
  | 'UNWRAP_COMPUTED'            // 展开结果（候选/切口/残差/树）
  | 'HEIGHT_COMPUTED'            // 高度转换链结果
  | 'JUDGEMENT_RECORDED'         // 机器可读的判定依据
  | 'CANDIDATE_ACCEPTED'         // 人工裁定：采纳某整周候选
  | 'REGION_LOCKED'              // 锁定局部解
  | 'LOCK_CONFLICT_RAISED'       // 局部锁定冲突
  | 'CONFLICT_RESOLVED'          // 冲突解决（写入历史）
  | 'DECISION_UNDONE'            // 撤销（写入历史，不删除原事件）
  | 'SCENARIO_RECORDED';         // 反例档案场景登记

export interface DomainEvent<T = unknown> {
  id: string;
  seq: number;                   // 单调序号 = 时间线顺序
  at: number;                    // 逻辑时间戳（可注入虚拟时间）
  type: EventType;
  actor: string;                 // 'system' | 审阅者 id
  payload: T;
}

export interface RawFrameRef { id: string; version: number; }

export interface UnwrapParams {
  algoVersion: 'pu-1.0.0';
  qualityThreshold: number;      // 信噪评分低于阈值 → 孔洞，不猜相位
  anchor: { row: number; col: number; k0: number } | 'auto';
  maxCandidates: number;
}

export interface UnwrapComputedPayload {
  resultId: string;
  inputs: {
    wrapped: RawFrameRef; quality: RawFrameRef; mask: RawFrameRef;
    cutHistoryHead: number;      // 使用的切口编辑历史长度（seq 指针）
  };
  params: UnwrapParams;
  paramsFingerprint: string;     // 参数指纹
  result: UnwrapResultData;
}

export interface PlaquetteResidue {
  row: number; col: number;      // 2x2  plaquette 左上角
  sumCycles: number;             // 环路和（单位：整周）
  status: 'closed' | 'unclosed';
  diagnosis?: string;
}

export interface Cut {
  id: string;
  source: 'residue-pairing' | 'manual-edit';
  segments: CutSegment[];
}

export interface CutOffset {
  cutId: string;
  segmentIndex: number;
  deltaK: number;                // 切口两侧显式整周偏移
}

export interface CycleCheck {
  nodes: Array<{ row: number; col: number }>;
  residualCycles: number;        // 非 0 = 循环不闭合
  closed: boolean;
}

export interface UnwrapCandidate {
  candidateId: string;
  label: string;                 // 例如 "k0=0" / "cycle#2 +1 侧"
  kGrid: (number | null)[];      // 每像素整周数，null = 未知（孔洞）
  path: Array<{ row: number; col: number }>;  // 展开树路径（根→叶抽样）
  cycleResiduals: CycleCheck[];
  rejectedReasons: string[];     // 被拒绝时的一等数据
  status: 'open' | 'accepted' | 'rejected';
}

export interface UnwrapResultData {
  width: number; height: number;
  components: number;            // >1 = 多连通区
  holes: Array<{ row: number; col: number; reason: 'LOW_AMPLITUDE' | 'MASKED_INVALID' }>;
  residues: PlaquetteResidue[];
  cuts: Cut[];
  cutOffsets: CutOffset[];
  treeEdges: Array<{ from: { row: number; col: number }; to: { row: number; col: number } }>;
  candidates: UnwrapCandidate[];
  diagnostics: Diagnostic[];
}

export interface HeightComputedPayload {
  resultId: string;
  inputs: {
    unwrapResultId: string;
    wavelength: RawFrameRef; geometry: RawFrameRef; calibration: RawFrameRef;
  };
  algoVersion: 'h-1.0.0';
  paramsFingerprint: string;
  result: HeightResultData;
}

export interface HeightResultData {
  heightGrid: (number | null)[]; // nm；null = 无法转换/未知，保留诊断
  unit: 'nm';
  frame: CoordFrame;
  chain: Array<{ step: string; detail: string }>;  // 高度转换链，逐步可重放
  diagnostics: Diagnostic[];
}

export interface JudgementRecordedPayload {
  ruleId: JudgementRuleId;
  subject: string;               // 作用对象（resultId / candidateId / region）
  verdict: 'applied' | 'violated' | 'waived';
  evidence: string;              // 机器可读依据（结构化 JSON 字符串）
}

export interface ScenarioRecordedPayload {
  scenarioKey: string;           // 相位跨越边界 / 低振幅孔洞 / ...
  mode: 'minimal' | 'combination';
  inputRefs: RawFrameRef[];
  resultIds: string[];
  affected: string[];            // 受影响对象 id
  status: 'expected-impact-confined' | 'impact-leaked' | 'rejected-input';
  note: string;
}
