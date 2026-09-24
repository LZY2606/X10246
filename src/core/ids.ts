import type { ContentKind, Entity, SourceContent, DerivedContent, ProvenanceRef } from "../shared/domain.ts";
import { digestOf, shortHash } from "../shared/hash.ts";

/** 内容摘要。 */
export function contentDigest(content: SourceContent | DerivedContent): string {
  return digestOf(content);
}

/** 人类可读内容摘要。 */
export function summarize(kind: ContentKind, content: SourceContent | DerivedContent): string {
  switch (kind) {
    case "WrappedPhaseFrame": {
      const c = content as Extract<SourceContent, { kind: "WrappedPhaseFrame" }>;
      return `包裹相位 ${c.grid.rows}x${c.grid.cols}，${c.pixels.length} 像素，周期 ${c.wrap.period.value}${c.wrap.period.unit}，来源 ${c.sourceFile}`;
    }
    case "AmplitudeFrame": {
      const c = content as Extract<SourceContent, { kind: "AmplitudeFrame" }>;
      return `振幅 ${c.grid.rows}x${c.grid.cols}（${c.unit}），来源 ${c.sourceFile}`;
    }
    case "SnrScoreFrame": {
      const c = content as Extract<SourceContent, { kind: "SnrScoreFrame" }>;
      return `信噪评分 ${c.grid.rows}x${c.grid.cols}，方法 ${c.method}`;
    }
    case "InvalidMask": {
      const c = content as Extract<SourceContent, { kind: "InvalidMask" }>;
      return `无效遮罩 ${c.grid.rows}x${c.grid.cols}，无效像素 ${c.invalid.filter(Boolean).length}`;
    }
    case "Wavelength": {
      const c = content as Extract<SourceContent, { kind: "Wavelength" }>;
      return `波长 ${c.wavelength.value}${c.wavelength.unit}（${c.band}）`;
    }
    case "IncidenceGeometry": {
      const c = content as Extract<SourceContent, { kind: "IncidenceGeometry" }>;
      return `入射几何 入射角 ${c.incidenceAngle.value}${c.incidenceAngle.unit}`;
    }
    case "CalibrationSurface": {
      const c = content as Extract<SourceContent, { kind: "CalibrationSurface" }>;
      return `标定面 ${c.model.type}，拟合RMS ${c.fitResidualRms.value}${c.fitResidualRms.unit}`;
    }
    case "CutEditHistory": {
      const c = content as Extract<SourceContent, { kind: "CutEditHistory" }>;
      return `切口编辑历史 ${c.edits.length} 条（追加型，不可覆盖）`;
    }
    case "QualityMap":
      return "质量图（振幅/信噪融合，低振幅区标记）";
    case "ResidueMap": {
      const c = content as Extract<DerivedContent, { kind: "ResidueMap" }>;
      return `残差点 ${c.residues.length} 个，跨越边 ${c.boundaries.length} 条`;
    }
    case "CutNetwork": {
      const c = content as Extract<DerivedContent, { kind: "CutNetwork" }>;
      return `支路切口 ${c.edges.length} 条，连通区 ${c.components.length} 个`;
    }
    case "UnwrapResult": {
      const c = content as Extract<DerivedContent, { kind: "UnwrapResult" }>;
      return `展开树 ${c.trees.length} 棵，未知像素 ${c.unknownPixels.length}，候选拒绝 ${c.rejected.length}`;
    }
    case "CycleResidualSet": {
      const c = content as Extract<DerivedContent, { kind: "CycleResidualSet" }>;
      return `循环残差（${c.treeId}）：${c.cycles.length} 个回路，未闭合 ${c.cycles.filter((x) => !x.closed).length}`;
    }
    case "HeightResult": {
      const c = content as Extract<DerivedContent, { kind: "HeightResult" }>;
      return `高度转换链（${c.treeId}）：${c.heights.filter((h) => h !== null).length} 点，单位 ${c.unit}`;
    }
    case "ReviewDecision": {
      const c = content as Extract<DerivedContent, { kind: "ReviewDecision" }>;
      return `人工决定 ${c.verdict}（${c.decisionId}）`;
    }
    case "InterpretationLock": {
      const c = content as Extract<DerivedContent, { kind: "InterpretationLock" }>;
      return `局部锁定 ${c.lockId} ${c.status}（${c.scope.label}）`;
    }
  }
}

/** 逻辑实体族 id：同类/同源的版本共享 lineageId（来源按 kind+源文件稳定）。 */
export function lineageIdFor(kind: ContentKind, content: SourceContent | DerivedContent, salt?: string): string {
  const keyBase: Record<string, unknown> = {};
  if ("sourceFile" in (content as object)) keyBase.f = (content as { sourceFile?: string }).sourceFile;
  if ("treeId" in (content as object)) keyBase.t = (content as { treeId?: string }).treeId;
  if ("decisionId" in (content as object)) keyBase.d = (content as { decisionId?: string }).decisionId;
  if ("lockId" in (content as object)) keyBase.l = (content as { lockId?: string }).lockId;
  keyBase.kind = kind;
  if (salt) keyBase.salt = salt;
  return `${kind}:${shortHash(keyBase, 10)}`;
}

let idCounter = 0;
export function makeEntityId(kind: ContentKind, digest: string, version: number): string {
  idCounter = (idCounter + 1) % 100000;
  return `${kind}:v${version}:${digest.slice(0, 12)}`;
}

export interface EntityFactoryInput {
  kind: ContentKind;
  content: SourceContent | DerivedContent;
  version: number;
  parent: Entity | null;
  lineageSalt?: string;
  algorithmVersion?: string;
  parameterFingerprint?: string;
  directSources: ProvenanceRef[];
  createdAt: string;
}

export function buildEntity(input: EntityFactoryInput, existing?: Entity): Entity {
  const digest = contentDigest(input.content);
  const lineageId = existing?.lineageId ?? lineageIdFor(input.kind, input.content, input.lineageSalt);
  const entityId = makeEntityId(input.kind, digest, input.version);
  return {
    entityId,
    lineageId,
    version: input.version,
    parentVersionId: input.parent ? input.parent.entityId : null,
    kind: input.kind,
    digest,
    summary: summarize(input.kind, input.content),
    algorithmVersion: input.algorithmVersion,
    parameterFingerprint: input.parameterFingerprint,
    directSources: input.directSources,
    content: input.content,
    createdAt: input.createdAt,
    freshness: "current"
  };
}

export function refOf(entity: Entity): ProvenanceRef {
  return { entityId: entity.entityId, version: entity.version, digest: entity.digest };
}
