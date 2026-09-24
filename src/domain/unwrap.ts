/**
 * 二维相位展开引擎（确定性，固定参数指纹）。
 * 领域规则：
 *  - 低振幅区域不得猜相位：低于信噪阈值或落在无效遮罩内的像素标记为 unknown，绝不插值。
 *  - 切口两侧的整周偏移显式表示：每条切口边记录两侧整周偏移差。
 *  - 不同展开树可得到局部一致解：保留每棵树的访问路径与循环残差。
 */
import { contentDigest } from "./hash";

export const UNWRAP_ALGORITHM_VERSION = "unwrap-2d-quality-guided/1.2.0";

export interface UnwrapParams {
  lowAmplitudeThreshold: number; // 信噪评分阈值（snr_db）
  seedStrategy: "highest-quality" | "corner-nw" | "corner-se" | "center";
  integerSearchRadius: number;   // 整周多解搜索半径
}

export const DEFAULT_UNWRAP_PARAMS: UnwrapParams = {
  lowAmplitudeThreshold: 6,
  seedStrategy: "highest-quality",
  integerSearchRadius: 1,
};

export function paramFingerprint(p: UnwrapParams): string {
  return contentDigest({ algo: UNWRAP_ALGORITHM_VERSION, params: p }).slice(0, 16);
}

export interface UnwrapInput {
  width: number;
  height: number;
  wrapped: number[];  // rad, (-pi, pi]
  quality: number[];  // snr_db
  mask: number[];     // 1=有效 0=无效
  /** 人工切口编辑：禁止穿越的边（线性索引对，小索引在前）。 */
  manualCuts?: Array<[number, number]>;
}

export type HoleReason = "low-amplitude" | "invalid-mask";

export interface CutEdge {
  between: [number, number];
  /** 切口两侧显式整周偏移差 k[b]-k[a]。 */
  integerOffsetDelta: number;
  origin: "computed" | "manual";
}

export interface CycleResidual {
  plaquette: number[]; // 2x2 像素线性索引
  residualCycles: number; // 非零即循环不闭合
}

export interface UnwrapCandidate {
  candidateId: string;
  seedStrategy: UnwrapParams["seedStrategy"];
  /** 展开树访问路径（线性索引顺序）。 */
  path: number[];
  /** 每像素整周偏移；孔洞为 null。 */
  offsets: Array<number | null>;
  cycleResiduals: CycleResidual[];
  /** 与其他候选逐像素一致的区域（连通标签）。 */
  consistentWith: string[];
  status: "unique" | "undetermined" | "rejected" | "adopted";
  rejectReason?: string;
}

export interface UnwrapComponent {
  componentId: number;
  size: number;
  seed: number;
  /** 孤岛的绝对整周不可唯一决定时，列出全部合法候选。 */
  legalIntegerOffsets?: number[];
}

export interface UnwrapResult {
  algorithmVersion: string;
  paramFingerprint: string;
  width: number;
  height: number;
  holes: Array<{ index: number; reason: HoleReason }>;
  components: UnwrapComponent[];
  cuts: CutEdge[];
  cycles: CycleResidual[];
  candidates: UnwrapCandidate[];
  diagnostics: string[];
}

function wrapToPi(x: number): number {
  let v = x % (2 * Math.PI);
  if (v <= -Math.PI) v += 2 * Math.PI;
  if (v > Math.PI) v -= 2 * Math.PI;
  return v;
}

function neighbors(idx: number, w: number, h: number): number[] {
  const x = idx % w;
  const y = Math.floor(idx / w);
  const out: number[] = [];
  if (x > 0) out.push(idx - 1);
  if (x < w - 1) out.push(idx + 1);
  if (y > 0) out.push(idx - w);
  if (y < h - 1) out.push(idx + w);
  return out;
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function pickSeed(valid: boolean[], quality: number[], w: number, h: number, s: UnwrapParams["seedStrategy"]): number {
  const order: number[] = [];
  for (let i = 0; i < valid.length; i++) if (valid[i]) order.push(i);
  if (order.length === 0) return -1;
  switch (s) {
    case "highest-quality":
      order.sort((a, b) => quality[b]! - quality[a]! || a - b);
      return order[0]!;
    case "corner-nw":
      order.sort((a, b) => a - b);
      return order[0]!;
    case "corner-se":
      order.sort((a, b) => b - a);
      return order[0]!;
    case "center": {
      const cx = (w - 1) / 2, cy = (h - 1) / 2;
      order.sort(
        (a, b) =>
          (a % w - cx) ** 2 + (Math.floor(a / w) - cy) ** 2 -
          ((b % w - cx) ** 2 + (Math.floor(b / w) - cy) ** 2) || a - b,
      );
      return order[0]!;
    }
  }
}

interface TreeRun {
  offsets: Array<number | null>;
  path: number[];
  componentOf: Array<number | null>;
  components: UnwrapComponent[];
}

function runTree(input: UnwrapInput, valid: boolean[], strategy: UnwrapParams["seedStrategy"]): TreeRun {
  const { width: w, height: h, wrapped } = input;
  const n = w * h;
  const offsets: Array<number | null> = new Array(n).fill(null);
  const componentOf: Array<number | null> = new Array(n).fill(null);
  const path: number[] = [];
  const components: UnwrapComponent[] = [];
  const manual = new Set((input.manualCuts ?? []).map(([a, b]) => edgeKey(a, b)));

  let remaining = valid.slice();
  let compId = 0;
  while (true) {
    const seed = pickSeed(remaining, input.quality, w, h, strategy);
    if (seed < 0) break;
    const queue: number[] = [seed];
    offsets[seed] = 0;
    componentOf[seed] = compId;
    remaining[seed] = false;
    let size = 0;
    while (queue.length > 0) {
      const i = queue.shift()!;
      path.push(i);
      size++;
      for (const j of neighbors(i, w, h)) {
        if (!remaining[j]) continue;
        if (manual.has(edgeKey(i, j))) continue; // 人工切口不可穿越
        const g = wrapToPi(wrapped[j]! - wrapped[i]!);
        const unwrappedJ = wrapped[j]! + 2 * Math.PI * (offsets[i]! + Math.round((g - (wrapped[j]! - wrapped[i]!)) / (2 * Math.PI)));
        // 以 i 为锚：unwrapped[j] = unwrapped[i] + wrap(wj-wi)
        const anchor = wrapped[i]! + 2 * Math.PI * offsets[i]!;
        const uj = anchor + wrapToPi(wrapped[j]! - wrapped[i]!);
        void unwrappedJ;
        offsets[j] = Math.round((uj - wrapped[j]!) / (2 * Math.PI));
        componentOf[j] = compId;
        remaining[j] = false;
        queue.push(j);
      }
    }
    components.push({ componentId: compId, size, seed });
    compId++;
  }
  return { offsets, path, componentOf, components };
}

function computeCycles(input: UnwrapInput, valid: boolean[]): CycleResidual[] {
  const { width: w, height: h, wrapped } = input;
  const cycles: CycleResidual[] = [];
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const p = [y * w + x, y * w + x + 1, (y + 1) * w + x + 1, (y + 1) * w + x];
      if (!p.every((i) => valid[i])) continue;
      let sum = 0;
      for (let e = 0; e < 4; e++) {
        const a = p[e]!, b = p[(e + 1) % 4]!;
        sum += wrapToPi(wrapped[b]! - wrapped[a]!);
      }
      const residual = sum / (2 * Math.PI);
      if (Math.abs(residual) > 1e-9) {
        cycles.push({ plaquette: p, residualCycles: Math.round(residual) });
      }
    }
  }
  return cycles;
}

function computeCuts(input: UnwrapInput, valid: boolean[], offsets: Array<number | null>): CutEdge[] {
  const { width: w, height: h, wrapped } = input;
  const cuts: CutEdge[] = [];
  const manual = new Set((input.manualCuts ?? []).map(([a, b]) => edgeKey(a, b)));
  for (let i = 0; i < w * h; i++) {
    if (!valid[i]) continue;
    for (const j of neighbors(i, w, h)) {
      if (j <= i || !valid[j]) continue;
      const wrapCount = Math.round((wrapped[j]! - wrapped[i]! - wrapToPi(wrapped[j]! - wrapped[i]!)) / (2 * Math.PI));
      const delta = (offsets[j] ?? 0) - (offsets[i] ?? 0);
      const crossing = delta - wrapCount;
      const key = edgeKey(i, j);
      if (manual.has(key)) {
        cuts.push({ between: [i, j], integerOffsetDelta: delta, origin: "manual" });
      } else if (crossing !== 0) {
        cuts.push({ between: [i, j], integerOffsetDelta: delta, origin: "computed" });
      }
    }
  }
  return cuts;
}

export function unwrap2d(input: UnwrapInput, params: UnwrapParams = DEFAULT_UNWRAP_PARAMS): UnwrapResult {
  const { width: w, height: h, quality, mask } = input;
  const n = w * h;
  const diagnostics: string[] = [];
  const valid: boolean[] = new Array(n).fill(false);
  const holes: UnwrapResult["holes"] = [];
  for (let i = 0; i < n; i++) {
    if (mask[i] !== 1) {
      holes.push({ index: i, reason: "invalid-mask" });
    } else if (quality[i]! < params.lowAmplitudeThreshold) {
      // 领域规则：低振幅区域不得猜相位
      holes.push({ index: i, reason: "low-amplitude" });
    } else {
      valid[i] = true;
    }
  }

  const strategies: UnwrapParams["seedStrategy"][] = ["highest-quality", "corner-nw", "corner-se", "center"];
  const runs = strategies.map((s) => ({ s, run: runTree(input, valid, s) }));
  const primary = runs[0]!.run;
  const cycles = computeCycles(input, valid);
  const cuts = computeCuts(input, valid, primary.offsets);

  // 孤岛分量：绝对整周不可唯一决定 → 枚举全部合法候选
  for (const c of primary.components) {
    const touchesBorder = primary.componentOf.some((cid, i) => {
      if (cid !== c.componentId) return false;
      const x = i % w, y = Math.floor(i / w);
      return x === 0 || y === 0 || x === w - 1 || y === h - 1;
    });
    if (primary.components.length > 1 && !touchesBorder) {
      const r = params.integerSearchRadius;
      c.legalIntegerOffsets = Array.from({ length: 2 * r + 1 }, (_, k) => k - r);
      diagnostics.push(
        `分量 ${c.componentId} 为孔洞包围的孤岛，绝对整周不可唯一决定，保留 ${2 * r + 1} 个合法候选`,
      );
    }
  }

  const candidates: UnwrapCandidate[] = runs.map(({ s, run }) => {
    const consistentWith = runs
      .filter((o) => o.s !== s)
      .filter((o) => {
        for (let i = 0; i < n; i++) {
          const a = run.offsets[i], b = o.run.offsets[i];
          if (a === null || b === null) continue;
          if (run.componentOf[i] !== o.run.componentOf[i]) continue;
          if (a !== b) return false;
        }
        return true;
      })
      .map((o) => `cand-${o.s}`);
    return {
      candidateId: `cand-${s}`,
      seedStrategy: s,
      path: run.path,
      offsets: run.offsets,
      cycleResiduals: cycles,
      consistentWith,
      status: cycles.length === 0 && consistentWith.length === runs.length - 1 ? "unique" : "undetermined",
    };
  });

  if (cycles.length > 0) {
    diagnostics.push(`检测到 ${cycles.length} 个循环不闭合残差，候选解保留路径与残差供人工裁定`);
  }
  if (holes.some((hh) => hh.reason === "low-amplitude")) {
    diagnostics.push("低振幅区域已标记为 unknown，未进行相位猜测");
  }

  return {
    algorithmVersion: UNWRAP_ALGORITHM_VERSION,
    paramFingerprint: paramFingerprint(params),
    width: w,
    height: h,
    holes,
    components: primary.components,
    cuts,
    cycles,
    candidates,
    diagnostics,
  };
}
