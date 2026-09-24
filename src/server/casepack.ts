/** 离线案例包加载器：按 replay.json 逐步重放，全部经过 Store 的正常状态机。 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, SourceRef } from './store.js';

export const CASE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cases', 'interference-book');

interface ReplayStep {
  op: string;
  [key: string]: unknown;
}

export interface CaseLoadSummary {
  entities: number;
  results: number;
  events: number;
  decisions: number;
  locks: number;
  scenarioCoverage: string[];
  saved: Record<string, string[]>;
}

function readJson(dir: string, rel: string): unknown {
  return JSON.parse(readFileSync(join(dir, rel), 'utf8'));
}

export function loadCasePack(store: Store, dir: string = CASE_DIR): CaseLoadSummary {
  const replay = readJson(dir, 'replay.json') as { steps: ReplayStep[] };
  const saved = new Map<string, string[]>();
  const scenarios = new Set<string>();
  let lastDecisionId: string | null = null;

  const latestRef = (entityId: string): SourceRef => {
    const v = store.getEntityVersion(entityId);
    return { entityId, versionNo: v.versionNo };
  };
  const resolveToken = (token: string): string => {
    const m = /^([A-Za-z0-9:_/-]+)(?:\[(\d+)\])?$/.exec(token);
    if (!m) throw new Error(`bad token ${token}`);
    const list = saved.get(m[1]);
    if (!list) throw new Error(`unknown saved ref ${m[1]}`);
    const i = m[2] ? Number(m[2]) : 0;
    if (i >= list.length) throw new Error(`saved ref ${token} out of range`);
    return list[i];
  };
  const saveAs = (name: string | undefined, ids: string[]) => {
    if (name) saved.set(name, ids);
  };

  const commitFile = (step: ReplayStep, entityId: string, kind: string, file: string) => {
    const content = readJson(dir, file);
    const meta = (step.meta ?? {}) as Record<string, unknown>;
    return store.commitInput({
      kind: kind as never,
      entityId,
      content,
      meta: {
        note: (meta.note as string) ?? `case:${file}`,
        region: meta.region as never,
        source: `case-pack:${file}`,
      },
      actor: 'lab-import',
    });
  };

  const runScenario = (id: string) => {
    scenarios.add(id);
    for (const variant of ['minimal', 'combined'] as const) {
      const prefix = `scn/${id}/${variant}`;
      commitFile({ op: 'commit', meta: { note: `scenario:${id}:${variant}` } }, `${prefix}/wrapped-phase`, 'wrapped_phase', `scenarios/${id}/${variant}/wrapped_phase.json`);
      commitFile({ op: 'commit', meta: { note: `scenario:${id}:${variant}` } }, `${prefix}/quality-map`, 'quality_map', `scenarios/${id}/${variant}/quality_map.json`);
      commitFile({ op: 'commit', meta: { note: `scenario:${id}:${variant}` } }, `${prefix}/invalid-mask`, 'invalid_mask', `scenarios/${id}/${variant}/invalid_mask.json`);
      const { candidateIds } = store.runUnwrap({
        refs: {
          wrappedPhase: latestRef(`${prefix}/wrapped-phase`),
          quality: latestRef(`${prefix}/quality-map`),
          invalidMask: latestRef(`${prefix}/invalid-mask`),
        },
        actor: `scenario:${id}`,
      });
      saveAs(variant === 'minimal' ? `scn:${id}` : `scn:${id}-combined`, candidateIds);
      store.appendEvent('scenario.completed', {
        scenario: id,
        variant,
        candidateIds,
        note: 'input fragments, judgment status and affected objects recorded',
      });
    }
  };

  for (const step of replay.steps) {
    switch (step.op) {
      case 'commit': {
        commitFile(step, step.entityId as string, step.kind as string, step.file as string);
        break;
      }
      case 'unwrap': {
        const { candidateIds } = store.runUnwrap({
          refs: {
            wrappedPhase: latestRef(step.phase as string),
            quality: latestRef(step.quality as string),
            invalidMask: latestRef(step.mask as string),
          },
          params: step.params as never,
          actor: 'reviewer',
        });
        saveAs(step.save as string | undefined, candidateIds);
        break;
      }
      case 'height': {
        const { resultId } = store.runHeight({
          candidateResultId: resolveToken(step.candidate as string),
          refs: {
            wavelength: latestRef(step.wavelength as string),
            incidenceGeometry: latestRef(step.geometry as string),
            calibrationPlane: latestRef(step.calibration as string),
          },
          actor: 'reviewer',
        });
        saveAs(step.save as string | undefined, [resultId]);
        break;
      }
      case 'decide': {
        const { decisionId } = store.decide({
          resultId: resolveToken(step.result as string),
          action: step.action as never,
          reason: step.reason as string,
          actor: 'reviewer',
        });
        lastDecisionId = decisionId;
        break;
      }
      case 'undo-last-decision': {
        if (lastDecisionId) store.undoDecision(lastDecisionId, 'reviewer');
        break;
      }
      case 'lock': {
        const { lockId } = store.lockLocal({
          resultId: resolveToken(step.result as string),
          region: step.region as never,
          kOffsets: step.kOffsets as Record<string, number>,
          actor: 'reviewer',
        });
        saveAs(step.save as string | undefined, [lockId]);
        break;
      }
      case 'resolve-lock': {
        store.resolveLockConflict({
          keepLockId: resolveToken(step.keep as string),
          dropLockId: resolveToken(step.drop as string),
          reason: step.reason as string,
          actor: 'reviewer',
        });
        break;
      }
      case 'run-scenario': {
        runScenario(step.id as string);
        break;
      }
      default:
        throw new Error(`unknown replay op ${step.op}`);
    }
  }

  return {
    entities: store.listEntities().length,
    results: store.listResults().length,
    events: store.listEvents().length,
    decisions: 0,
    locks: store.listLocks().length,
    scenarioCoverage: [...scenarios],
    saved: Object.fromEntries(saved),
  };
}
