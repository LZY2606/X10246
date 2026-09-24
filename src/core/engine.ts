/**
 * 复核状态机：导入 → 基线核对 → 情形触发 → 候选生成 → 裁定 → 局部锁定 → 高度链。
 * 状态由事件折叠投影得到，因此回到任意旧事件即可恢复当时的可见结论。
 */
import { Store, type VersionRef } from "./store";
import type { Clock } from "../domain/clock";
import { stableId } from "../domain/hash";
import {
  INPUT_KINDS,
  type GridPayload,
  type InputKind,
  type ScenarioKind,
  type WavelengthPayload,
  type IncidenceGeometryPayload,
  type CalibrationSurfacePayload,
  type CutEditHistoryPayload,
  type DecisionRule,
} from "../domain/types";
import {
  unwrap2d,
  DEFAULT_UNWRAP_PARAMS,
  type UnwrapParams,
  type UnwrapResult,
} from "../domain/unwrap";
import { heightChain, type HeightChainResult } from "../domain/height";
import type { DomainEvent } from "./events";

export interface LockView {
  lockId: string;
  region: number[];
  owner: string;
  candidateId: string;
  status: "active" | "released" | "conflict";
  seq: number;
}

export interface ReviewState {
  /** resultId -> 被采纳候选 */
  adopted: Record<string, string>;
  /** candidateId -> 拒绝原因 */
  rejected: Record<string, string>;
  locks: Record<string, LockView>;
  expiredResults: string[];
  currentParams: UnwrapParams;
  undoneSeqs: number[];
  lastUnwrapResultId: string | null;
  lastHeightResultId: string | null;
}

export class ReviewEngine {
  constructor(
    private store: Store,
    private clock: Clock,
  ) {}

  // ---------- 导入 ----------
  importInput(kind: InputKind, payload: unknown, note?: string, entityId?: string): VersionRef {
    const id = entityId ?? this.store.createEntity(kind);
    const ref = this.store.addVersion(id, payload, { note });
    this.store.appendEvent("input.imported", { entityId: id, kind, versionNo: ref.versionNo, digest: ref.digest, note });
    return ref;
  }

  reviseInput(entityId: string, payload: unknown, note: string): VersionRef {
    const head = this.store.headVersion(entityId);
    if (!head) throw new Error(`实体 ${entityId} 无初始版本，不能修订`);
    const ref = this.store.addVersion(entityId, payload, { note });
    this.store.appendEvent("input.revised", {
      entityId,
      versionNo: ref.versionNo,
      parentVersionNo: head.versionNo,
      digest: ref.digest,
      note,
    });
    // 局部输入变化只使依赖它的派生结果过期；过期结果仍可查看
    for (const rec of this.store.listDerived()) {
      if (rec.sources.some((s) => s.entityId === entityId)) {
        this.store.appendEvent("result.expired", {
          resultId: rec.resultId,
          becauseOf: { entityId, versionNo: ref.versionNo },
        });
      }
    }
    return ref;
  }

  /** 基线核对：七类输入齐备且均不可覆盖。 */
  verifyBaseline(): { ok: boolean; missing: InputKind[] } {
    const present = new Set(this.store.listEntities().map((e) => e.kind));
    const missing = INPUT_KINDS.filter((k) => !present.has(k));
    const ok = missing.length === 0;
    if (ok) {
      this.store.appendEvent("baseline.verified", {
        kinds: INPUT_KINDS,
        heads: this.store.listEntities().map((e) => ({ entityId: e.entityId, kind: e.kind, versionNo: e.headVersionNo })),
      });
    }
    return { ok, missing };
  }

  // ---------- 计算 ----------
  private gridOf(kind: InputKind): { ref: VersionRef; grid: GridPayload } {
    const ent = this.store.listEntities().find((e) => e.kind === kind);
    if (!ent || ent.headVersionNo == null) throw new Error(`缺少输入：${kind}`);
    const { ref, content } = this.store.resolveVersion(ent.entityId, ent.headVersionNo);
    return { ref, grid: content as GridPayload };
  }

  runUnwrap(params: UnwrapParams = DEFAULT_UNWRAP_PARAMS): { resultId: string; result: UnwrapResult } {
    const wp = this.gridOf("wrapped_phase");
    const snr = this.gridOf("snr_score");
    const mask = this.gridOf("invalid_mask");
    const cutEnt = this.store.listEntities().find((e) => e.kind === "cut_edit_history");
    let manualCuts: Array<[number, number]> = [];
    const sources: VersionRef[] = [wp.ref, snr.ref, mask.ref];
    if (cutEnt && cutEnt.headVersionNo != null) {
      const { ref, content } = this.store.resolveVersion(cutEnt.entityId, cutEnt.headVersionNo);
      sources.push(ref);
      manualCuts = (content as CutEditHistoryPayload).entries
        .filter((e) => e.action === "add-cut")
        .map((e) => e.edge);
    }
    const result = unwrap2d(
      {
        width: wp.grid.width,
        height: wp.grid.height,
        wrapped: wp.grid.values,
        quality: snr.grid.values,
        mask: mask.grid.values,
        manualCuts,
      },
      params,
    );
    const resultId = stableId("res", { kind: "unwrap", fp: result.paramFingerprint, src: sources }, Date.now() % 1_000_000);
    this.store.putDerived({
      resultId,
      kind: "unwrap",
      algorithmVersion: result.algorithmVersion,
      paramFingerprint: result.paramFingerprint,
      sources,
      payload: result,
    });
    this.store.appendEvent("unwrap.completed", {
      resultId,
      algorithmVersion: result.algorithmVersion,
      paramFingerprint: result.paramFingerprint,
      sources,
      candidateIds: result.candidates.map((c) => c.candidateId),
      holeCount: result.holes.length,
      cutCount: result.cuts.length,
      cycleCount: result.cycles.length,
    });
    for (const d of result.diagnostics) {
      this.store.appendEvent("diagnostic.raised", { code: "unwrap", message: d, related: [resultId] });
    }
    return { resultId, result };
  }

  runHeight(resultId: string, candidateId: string): { heightResultId: string; result: HeightChainResult } {
    const unwrapRec = this.store.getDerived(resultId);
    const unwrapPayload = unwrapRec.payload as UnwrapResult;
    const cand = unwrapPayload.candidates.find((c) => c.candidateId === candidateId);
    if (!cand) throw new Error(`候选 ${candidateId} 不存在于结果 ${resultId}`);
    const wp = this.gridOf("wrapped_phase");
    const wlEnt = this.store.listEntities().find((e) => e.kind === "wavelength");
    const geoEnt = this.store.listEntities().find((e) => e.kind === "incidence_geometry");
    const calEnt = this.store.listEntities().find((e) => e.kind === "calibration_surface");
    if (!wlEnt || !geoEnt || !calEnt) throw new Error("高度链缺少波长/入射几何/标定面输入");
    const wl = this.store.resolveVersion(wlEnt.entityId, wlEnt.headVersionNo!);
    const geo = this.store.resolveVersion(geoEnt.entityId, geoEnt.headVersionNo!);
    const cal = this.store.resolveVersion(calEnt.entityId, calEnt.headVersionNo!);
    const result = heightChain({
      offsets: cand.offsets,
      wrapped: wp.grid.values,
      wavelength: (wl.content as WavelengthPayload).wavelength,
      incidenceAngle: (geo.content as IncidenceGeometryPayload).incidenceAngle,
      calibrationFlatnessNm: (cal.content as CalibrationSurfacePayload).flatness.value,
    });
    const sources: VersionRef[] = [
      { entityId: `derived:${resultId}`, versionNo: 0, digest: unwrapRec.digest },
      wl.ref,
      geo.ref,
      cal.ref,
    ];
    const heightResultId = stableId("res", { kind: "height", of: resultId, cand: candidateId }, Date.now() % 1_000_000);
    this.store.putDerived({
      resultId: heightResultId,
      kind: "height",
      algorithmVersion: result.algorithmVersion,
      paramFingerprint: result.fingerprint,
      sources,
      payload: { ...result, candidateId, unwrapResultId: resultId },
    });
    this.store.appendEvent("height.completed", {
      resultId: heightResultId,
      unwrapResultId: resultId,
      candidateId,
      sources,
      steps: result.steps.map((s) => s.name),
    });
    return { heightResultId, result };
  }

  // ---------- 裁定 ----------
  adoptCandidate(resultId: string, candidateId: string, reason: string, rules: DecisionRule[]): string {
    const decisionId = stableId("dec", { resultId, candidateId, act: "adopt" }, Date.now() % 1_000_000);
    this.store.appendEvent("candidate.adopted", { decisionId, resultId, candidateId, reason, rules });
    return decisionId;
  }

  rejectCandidate(resultId: string, candidateId: string, reason: string, rules: DecisionRule[]): string {
    const decisionId = stableId("dec", { resultId, candidateId, act: "reject" }, Date.now() % 1_000_000);
    this.store.appendEvent("candidate.rejected", { decisionId, resultId, candidateId, reason, rules });
    return decisionId;
  }

  adjustParams(params: UnwrapParams, reason: string): { resultId: string; result: UnwrapResult } {
    this.store.appendEvent("params.adjusted", { params, reason });
    return this.runUnwrap(params);
  }

  // ---------- 局部锁定 ----------
  acquireLock(region: number[], owner: string, candidateId: string): { lockId: string; conflict: boolean } {
    const state = this.projectState();
    const overlapping = Object.values(state.locks).filter(
      (l) => l.status !== "released" && l.region.some((p) => region.includes(p)),
    );
    const lockId = stableId("lock", { region, owner, candidateId }, Date.now() % 1_000_000);
    const conflict = overlapping.find((l) => l.candidateId !== candidateId);
    if (conflict) {
      this.store.appendEvent("lock.conflict", {
        lockId, region, owner, candidateId, conflictsWith: conflict.lockId,
      });
      return { lockId, conflict: true };
    }
    this.store.appendEvent("lock.acquired", { lockId, region, owner, candidateId });
    return { lockId, conflict: false };
  }

  releaseLock(lockId: string): void {
    this.store.appendEvent("lock.released", { lockId });
  }

  /** 撤销：写入历史，而非删除历史。 */
  undo(eventSeq: number, reason: string): void {
    this.store.appendEvent("decision.undone", { undoneEventSeq: eventSeq, reason });
  }

  // ---------- 情形触发 ----------
  triggerScenario(scenario: ScenarioKind, affectedEntities: string[], inputFragments: string[]): void {
    this.store.appendEvent("scenario.triggered", { scenario, affectedEntities, inputFragments });
  }

  // ---------- 投影（当前或任意历史点） ----------
  projectState(upToSeq?: number): ReviewState {
    const events = this.store.events(upToSeq);
    const state: ReviewState = {
      adopted: {},
      rejected: {},
      locks: {},
      expiredResults: [],
      currentParams: { ...DEFAULT_UNWRAP_PARAMS },
      undoneSeqs: [],
      lastUnwrapResultId: null,
      lastHeightResultId: null,
    };
    const undone = new Set<number>();
    for (const e of events) {
      if (e.type === "decision.undone") {
        const p = e.payload as { undoneEventSeq: number };
        undone.add(p.undoneEventSeq);
        state.undoneSeqs.push(p.undoneEventSeq);
      }
    }
    const apply = (e: DomainEvent): void => {
      const p = e.payload as Record<string, unknown>;
      switch (e.type) {
        case "unwrap.completed":
          state.lastUnwrapResultId = p.resultId as string;
          break;
        case "height.completed":
          state.lastHeightResultId = p.resultId as string;
          break;
        case "candidate.adopted":
          state.adopted[p.resultId as string] = p.candidateId as string;
          delete state.rejected[p.candidateId as string];
          break;
        case "candidate.rejected":
          state.rejected[p.candidateId as string] = p.reason as string;
          break;
        case "params.adjusted":
          state.currentParams = p.params as UnwrapParams;
          break;
        case "lock.acquired":
          state.locks[p.lockId as string] = {
            lockId: p.lockId as string,
            region: p.region as number[],
            owner: p.owner as string,
            candidateId: p.candidateId as string,
            status: "active",
            seq: e.seq,
          };
          break;
        case "lock.conflict":
          state.locks[p.lockId as string] = {
            lockId: p.lockId as string,
            region: p.region as number[],
            owner: p.owner as string,
            candidateId: p.candidateId as string,
            status: "conflict",
            seq: e.seq,
          };
          if (state.locks[p.conflictsWith as string]) {
            state.locks[p.conflictsWith as string]!.status = "conflict";
          }
          break;
        case "lock.released":
          if (state.locks[p.lockId as string]) state.locks[p.lockId as string]!.status = "released";
          break;
        case "result.expired":
          if (!state.expiredResults.includes(p.resultId as string)) {
            state.expiredResults.push(p.resultId as string);
          }
          break;
      }
    };
    for (const e of events) {
      if (undone.has(e.seq)) continue; // 被撤销的事件不产生效果，但事件本身保留在历史中
      apply(e);
    }
    return state;
  }
}
