import type {
  CounterScenario,
  Entity,
  InvariantJudgement,
  ScenarioRecord,
  SourceContent
} from "../shared/domain.ts";
import { digestOf } from "../shared/hash.ts";
import { parseSample, type SampleInput } from "./importer.ts";
import {
  commitSource,
  recordCounterScenario,
  runPipeline,
  type State,
  type StoreEnv
} from "./store.ts";
import type { PipelineResult } from "./store.ts";

export const CASE_SEED = "case-seed-2026";
export const CASE_START = "2026-09-24T00:00:00.000Z";

export interface ScenarioOutcome {
  accepted: { entityId: string; summary: string }[];
  rejected: { entityId: string; summary: string; reason: string }[];
  diagnostics: string[];
  humanDecisions: string[];
  affectedScope: string[];
  judgements: InvariantJudgement[];
}

export function commitSample(state: State, env: StoreEnv, sample: SampleInput): SourceContent[] {
  const contents = parseSample(sample, sample.sourceFile ?? "sample.json");
  const saved: SourceContent[] = [];
  for (const content of contents) {
    commitSource(state, env, content, [content]);
    saved.push(content);
  }
  return saved;
}

export function judgement(
  invariant: InvariantJudgement["invariant"],
  held: boolean,
  evidence: string[],
  detail: string
): InvariantJudgement {
  return { judgementId: `j-${invariant}-${held ? "held" : "violated"}`, invariant, held, evidence, detail };
}

export function evaluateOutcome(
  env: StoreEnv,
  state: State,
  salt: string,
  scenario: CounterScenario,
  pipe: PipelineResult,
  opts: { expectResidues?: boolean; expectNonClosed?: boolean; expectMultipleTrees?: boolean } = {}
): ScenarioOutcome {
  const accepted: ScenarioOutcome["accepted"] = [];
  const rejected: ScenarioOutcome["rejected"] = [];
  const diagnostics: string[] = [];
  const judgements: InvariantJudgement[] = [];

  const q = pipe.quality.content as import("../shared/domain").QualityMap;
  const res = pipe.residues.content as import("../shared/domain").ResidueMap;
  const cuts = pipe.cutNetwork.content as import("../shared/domain").CutNetwork;
  const unwrap = pipe.unwrap.content as import("../shared/domain").UnwrapResult;
  const cycles = pipe.cycles.content as import("../shared/domain").CycleResidualSet;

  [pipe.quality, pipe.residues, pipe.cutNetwork, pipe.unwrap, pipe.cycles, ...Object.values(pipe.heights)].forEach((e: Entity) =>
    accepted.push({ entityId: e.entityId, summary: e.summary })
  );

  const guessed = unwrap.trees.some((t) => t.unwrapped.some((v, p) => v !== null && q.pixelState[p] === "low-amplitude"));
  judgements.push(
    judgement(
      "no-guess-in-low-amplitude",
      !guessed,
      unwrap.unknownPixels.map((p) => `pixel:${p}`),
      guessed ? "低振幅像素被赋予展开相位（违规）" : `低振幅像素 ${unwrap.unknownPixels.join(",") || "∅"} 保持未知，未猜相位`
    )
  );

  const allExplicit = cuts.edges.length > 0 && cuts.edges.every((e) => Number.isInteger(e.integerOffset));
  judgements.push(
    judgement(
      "explicit-integer-offset-across-cut",
      allExplicit,
      cuts.edges.map((e) => `cut-edge:${e.edgeId}:k=${e.integerOffset}`),
      allExplicit ? `${cuts.edges.length} 条切口均带显式整周偏移` : "存在缺少显式整周偏移的切口"
    )
  );

  judgements.push(
    judgement(
      "tree-local-consistency-with-path-and-cycle-residual",
      unwrap.trees.every((t) => t.edges.length > 0),
      unwrap.trees.map((t) => t.treeId),
      `保留 ${unwrap.trees.length} 棵展开树路径与 ${cycles.cycles.length} 个循环残差`
    )
  );

  const multiPixels = unwrap.trees.flatMap((t) =>
    t.integerCandidates.map((cands, p) => ({ p, cands, t: t.treeId })).filter((x) => x.cands.length > 1)
  );
  judgements.push(
    judgement(
      "keep-all-legal-candidates",
      multiPixels.every((x) => x.cands.length >= 2),
      multiPixels.map((x) => `${x.t}:pixel:${x.p}:k={${x.cands.join(",")}}`),
      multiPixels.length ? `${multiPixels.length} 个像素保留多个合法整周候选` : "无整周多解像素（该场景可接受）"
    )
  );

  if (opts.expectResidues && res.residues.length === 0) diagnostics.push(`[${scenario}] 期望残差点但未检出`);
  if (opts.expectNonClosed && cycles.cycles.every((c) => c.closed)) diagnostics.push(`[${scenario}] 期望循环不闭合但全部闭合`);
  if (opts.expectMultipleTrees && unwrap.trees.length < 2) diagnostics.push(`[${scenario}] 期望多棵展开树但只有 ${unwrap.trees.length} 棵`);

  for (const rj of unwrap.rejected) rejected.push({ entityId: `${salt}:${rj.treeId}`, summary: `被拒绝展开树 ${rj.treeId}`, reason: rj.reason });

  return {
    accepted,
    rejected,
    diagnostics,
    humanDecisions: [],
    affectedScope: [pipe.quality.entityId, pipe.residues.entityId, pipe.cutNetwork.entityId, pipe.unwrap.entityId, pipe.cycles.entityId, ...Object.values(pipe.heights).map((h) => h.entityId)],
    judgements
  };
}

export function mergeJudgements(a: InvariantJudgement[], b: InvariantJudgement[]): InvariantJudgement[] {
  const map = new Map<string, InvariantJudgement>();
  for (const j of [...a, ...b]) {
    const prev = map.get(j.invariant);
    if (!prev) map.set(j.invariant, j);
    else map.set(j.invariant, { ...prev, held: prev.held && j.held, evidence: [...new Set([...prev.evidence, ...j.evidence])], detail: `${prev.detail} | ${j.detail}` });
  }
  return [...map.values()];
}

export function registerScenario(
  state: State,
  env: StoreEnv,
  scenario: CounterScenario,
  changedDirectSource: string,
  fragments: { minimal: unknown[]; combined: unknown[] },
  minimal: ScenarioOutcome,
  combined: ScenarioOutcome
): void {
  for (const f of [...fragments.minimal, ...fragments.combined]) {
    if (!(digestOf(f) in state.blobs)) state.blobs[digestOf(f)] = f;
  }
  const record: ScenarioRecord = {
    scenario,
    minimalInput: { changedDirectSource, fragmentHashes: fragments.minimal.map(digestOf), interpretationVersion: `interp-min-${scenario}` },
    combinedInput: { fragmentHashes: fragments.combined.map(digestOf), interpretationVersion: `interp-comb-${scenario}` },
    accepted: [...minimal.accepted, ...combined.accepted],
    rejected: [...minimal.rejected, ...combined.rejected],
    failureDiagnostics: [...minimal.diagnostics, ...combined.diagnostics],
    humanDecisions: [...minimal.humanDecisions, ...combined.humanDecisions],
    affectedScope: [...new Set([...minimal.affectedScope, ...combined.affectedScope])],
    judgements: mergeJudgements(minimal.judgements, combined.judgements)
  };
  recordCounterScenario(state, env, record);
}

export function compute(
  env: StoreEnv,
  state: State,
  salt: string,
  scenario: CounterScenario,
  expect?: { expectResidues?: boolean; expectNonClosed?: boolean; expectMultipleTrees?: boolean }
) {
  const pipe = runPipeline(state, env, { salt });
  return evaluateOutcome(env, state, salt, scenario, pipe, expect);
}
