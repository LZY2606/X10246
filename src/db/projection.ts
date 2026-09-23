/**
 * 投影：从只追加事件重放出工作状态。
 *
 * 关键语义：
 *  - 每个实体保留所有版本；current 指向最新版本；
 *  - 派生结果带直接来源；当任一来源在该结果之后产生新版本时，结果标记 stale，
 *    但仍可查看（不能冒充当前）；
 *  - 查询实体返回它引用的版本号与内容摘要；缺少引用 -> CORRUPT，绝不退回最新版；
 *  - at(seq)：回到任意旧事件，恢复当时依赖版本与可见结论。
 */
import type { Ledger } from './ledger.ts';
import { canonicalJson } from '../domain/hash.ts';
import type { EntityType, EventRecord } from '../domain/types.ts';

export interface EntityVersionView {
  event: EventRecord;
  stale: boolean;
  dependencies: Array<{ eventId: string; missing: boolean; label: string }>;
  contentSummary: string;
  contentBytes: number;
}

export interface EntityView {
  type: EntityType;
  key: string;
  currentVersion: number;
  versions: EntityVersionView[];
}

export interface ProjectState {
  projectId: string;
  headSeq: number;
  entities: Map<string, EntityView>;
  events: EventRecord[];
  corruptions: Corruption[];
}

export interface Corruption {
  eventId: string;
  missingRef: string;
  message: string;
}

const ekey = (t: EntityType, k: string): string => t + '::' + k;

export function projectState(ledger: Ledger, projectId: string): ProjectState {
  const events = ledger.listEvents(projectId);
  const entities = new Map<string, EntityView>();
  const corruptions: Corruption[] = [];
  const eventIds = new Set(events.map((e) => e.eventId));

  for (const event of events) {
    const key = ekey(event.entity.type, event.entity.key);
    let view = entities.get(key);
    if (!view) {
      view = { type: event.entity.type, key: event.entity.key, currentVersion: 0, versions: [] };
      entities.set(key, view);
    }
    const content = ledger.getContent(event.contentId);
    const dependencies = event.refs.map((ref) => {
      const missing = !eventIds.has(ref);
      if (missing) {
        corruptions.push({
          eventId: event.eventId,
          missingRef: ref,
          message: `事件 ${event.seq} (${event.type}) 引用缺失：${ref}；档案损坏，不回退最新版`,
        });
      }
      return { eventId: ref, missing, label: refLabel(ledger, ref, eventIds) };
    });
    view.versions.push({
      event,
      stale: false,
      dependencies,
      contentSummary: summarize(event, content?.canonical ?? ''),
      contentBytes: content?.bytes ?? 0,
    });
    view.currentVersion = event.version;
  }

  for (const view of entities.values()) {
    for (const v of view.versions) v.stale = isStale(v.event, events);
  }

  return {
    projectId,
    headSeq: events.length ? events[events.length - 1].seq : -1,
    entities,
    events,
    corruptions,
  };
}

function refLabel(ledger: Ledger, ref: string, ids: Set<string>): string {
  if (!ids.has(ref)) return 'MISSING';
  const ev = ledger.getEvent(ref);
  if (!ev) return 'MISSING';
  return `${ev.entity.type}@${ev.entity.key}#v${ev.version}`;
}

function isStale(event: EventRecord, all: EventRecord[]): boolean {
  const derived: EventRecord['type'][] = [
    'quality.computed',
    'residues.computed',
    'regions.computed',
    'cuts.computed',
    'unwrap.computed',
    'integers.computed',
    'height.computed',
  ];
  if (!derived.includes(event.type)) return false;
  for (const ref of event.refs) {
    const refEvent = all.find((e) => e.eventId === ref);
    if (!refEvent) continue;
    const newer = all.find(
      (e) =>
        e.seq > event.seq &&
        e.entity.type === refEvent.entity.type &&
        e.entity.key === refEvent.entity.key &&
        e.eventId !== refEvent.eventId,
    );
    if (newer) return true;
  }
  return false;
}

function summarize(event: EventRecord, canonical: string): string {
  const p = event.payload as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of [
    'algorithmVersion',
    'parameterFingerprint',
    'treeVariant',
    'label',
    'kind',
    'decision',
    'lock',
  ]) {
    if (p[k] !== undefined) parts.push(`${k}=${String(p[k])}`);
  }
  if (Array.isArray(p.residues)) parts.push(`residues=${p.residues.length}`);
  if (Array.isArray(p.cuts)) parts.push(`cuts=${p.cuts.length}`);
  if (Array.isArray(p.regions)) parts.push(`regions=${p.regions.length}`);
  if (Array.isArray(p.ambiguities)) parts.push(`ambiguities=${p.ambiguities.length}`);
  if (Array.isArray(p.steps)) parts.push(`steps=${p.steps.length}`);
  if (Array.isArray(p.placements)) parts.push(`tiles=${p.placements.length}`);
  if (Array.isArray(p.edits)) parts.push(`edits=${p.edits.length}`);
  if (p.value && typeof p.value === 'object') {
    const v = p.value as { raw?: unknown; normalizedUnit?: string };
    parts.push(`raw=${String(v.raw)} ${v.normalizedUnit ?? ''}`);
  }
  const digest = canonical.length ? canonical.slice(0, 18) : '';
  return `${parts.join(' ')} ${digest}`.trim();
}

export interface SnapshotResponse {
  asOfSeq: number;
  currentAtSeq: Record<
    string,
    { type: EntityType; key: string; version: number; eventId: string }
  >;
  visibleEvents: number;
  corruption: Corruption[];
}

export function snapshotAt(ledger: Ledger, projectId: string, seq: number): SnapshotResponse {
  const state = projectState(ledger, projectId);
  const currentAtSeq: SnapshotResponse['currentAtSeq'] = {};
  const visible = state.events.filter((e) => e.seq <= seq);
  for (const e of visible) {
    currentAtSeq[ekey(e.entity.type, e.entity.key)] = {
      type: e.entity.type,
      key: e.entity.key,
      version: e.version,
      eventId: e.eventId,
    };
  }
  const ids = new Set(visible.map((e) => e.eventId));
  const corruption: Corruption[] = [];
  for (const e of visible) {
    for (const ref of e.refs) {
      if (!ids.has(ref)) {
        corruption.push({
          eventId: e.eventId,
          missingRef: ref,
          message: `@seq${seq}: ${e.type} 的引用 ${ref} 在该时刻不存在`,
        });
      }
    }
  }
  return { asOfSeq: seq, currentAtSeq, visibleEvents: visible.length, corruption };
}

export function entityDigest(event: EventRecord): Record<string, unknown> {
  return {
    eventId: event.eventId,
    seq: event.seq,
    at: event.at,
    type: event.type,
    entity: event.entity,
    version: event.version,
    parentVersionEventId: event.parentVersionEventId,
    refs: event.refs,
    actor: event.actor,
    contentId: event.contentId,
    contentCanonicalLength: canonicalJson(event.payload).length,
  };
}
