/**
 * 离线档案导出/导入。
 * 导出：projects + contents + tiles + events（按 seq 顺序）。
 * 导入：逐条重算 contentId / eventId 校验，身份、顺序与来源关系保持；
 *      共享瓦片只存一份；引用缺失或哈希不符 -> 拒绝（损坏）。
 */
import { canonicalJson, contentHash, eventId } from '../domain/hash.ts';
import type { Ledger } from './ledger.ts';

export interface ExportBundle {
  format: 'interferogram-review-ledger';
  bundleVersion: string;
  exportedAt: string;
  projects: Array<{
    projectId: string;
    name: string;
    createdAt: string;
    scenarioTags: string[];
  }>;
  contents: Array<{ contentId: string; kind: string; canonical: string }>;
  tiles: Array<{ contentId: string; canonical: string }>;
  events: BundleEvent[];
}

interface BundleEvent {
  eventId: string;
  projectId: string;
  seq: number;
  type: string;
  parentEventId: string | null;
  at: string;
  contentId: string;
  refs: string[];
  entityType: string;
  entityKey: string;
  version: number;
  parentVersionEventId: string | null;
  actor: string;
  payload: unknown;
}

export function exportProject(ledger: Ledger, projectId: string, exportedAt: string): ExportBundle {
  const project = ledger.getProject(projectId);
  if (!project) throw new Error('UNKNOWN_PROJECT:' + projectId);
  const events = ledger.listEvents(projectId);
  const contentIds = new Set<string>();
  for (const e of events) contentIds.add(e.contentId);
  const contents = [...contentIds].map((id) => {
    const c = ledger.getContent(id)!;
    return { contentId: c.contentId, kind: c.kind, canonical: c.canonical };
  });
  const tiles = ledger.allTiles().map((t) => ({ contentId: t.content_id, canonical: t.canonical }));
  return {
    format: 'interferogram-review-ledger',
    bundleVersion: '1.0.0',
    exportedAt,
    projects: [
      {
        projectId: project.projectId,
        name: project.name,
        createdAt: project.createdAt,
        scenarioTags: project.scenarioTags,
      },
    ],
    contents,
    tiles,
    events: events.map((e) => ({
      eventId: e.eventId,
      projectId: e.projectId,
      seq: e.seq,
      type: e.type,
      parentEventId: e.parentEventId,
      at: e.at,
      contentId: e.contentId,
      refs: e.refs,
      entityType: e.entity.type,
      entityKey: e.entity.key,
      version: e.version,
      parentVersionEventId: e.parentVersionEventId,
      actor: e.actor,
      payload: e.payload,
    })),
  };
}

export interface ImportReport {
  importedProjects: number;
  importedContents: number;
  importedTiles: number;
  importedEvents: number;
  verified: boolean;
}

export function importBundle(ledger: Ledger, bundle: ExportBundle): ImportReport {
  if (bundle.format !== 'interferogram-review-ledger') {
    throw new Error('BAD_BUNDLE_FORMAT');
  }
  // 1) 校验所有内容哈希
  for (const c of bundle.contents) {
    const parsed = JSON.parse(c.canonical);
    if (contentHash(parsed) !== c.contentId) {
      throw new Error('CONTENT_HASH_MISMATCH:' + c.contentId);
    }
  }
  for (const t of bundle.tiles) {
    if (contentHash(JSON.parse(t.canonical)) !== t.contentId) {
      throw new Error('TILE_HASH_MISMATCH:' + t.contentId);
    }
  }

  return ledger.db.transaction(() => {
    for (const p of bundle.projects) {
      ledger.createProject({
        projectId: p.projectId,
        name: p.name,
        createdAt: p.createdAt,
        scenarioTags: p.scenarioTags,
      });
    }
    let contents = 0;
    for (const c of bundle.contents) {
      const exists = ledger.getContent(c.contentId);
      if (!exists) {
        ledger.db
          .prepare('INSERT INTO contents(content_id,kind,canonical,bytes) VALUES(?,?,?,?)')
          .run(c.contentId, c.kind, c.canonical, Buffer.byteLength(c.canonical, 'utf8'));
        contents++;
      }
    }
    let tiles = 0;
    for (const t of bundle.tiles) {
      const parsed = ledger.getTile(t.contentId);
      if (parsed === null) {
        ledger.db
          .prepare('INSERT INTO tiles(content_id,canonical,bytes) VALUES(?,?,?)')
          .run(t.contentId, t.canonical, Buffer.byteLength(t.canonical, 'utf8'));
        tiles++;
      }
    }

    // 2) 按 seq 顺序重放并逐条重算 eventId 校验
    const byProject = new Map<string, BundleEvent[]>();
    for (const e of bundle.events) {
      const arr = byProject.get(e.projectId) ?? [];
      arr.push(e);
      byProject.set(e.projectId, arr);
    }
    let events = 0;
    for (const [, arr] of byProject) {
      arr.sort((a, b) => a.seq - b.seq);
      let prevEventId: string | null = null;
      for (const e of arr) {
        if (e.parentEventId !== prevEventId) {
          throw new Error('EVENT_CHAIN_BROKEN_AT_SEQ:' + e.seq);
        }
        const expectId = eventId({
          type: e.type,
          projectId: e.projectId,
          seq: e.seq,
          parentEventId: e.parentEventId,
          payloadContentId: e.contentId,
        });
        if (expectId !== e.eventId) throw new Error('EVENT_ID_MISMATCH_AT_SEQ:' + e.seq);
        if (contentHash(e.payload) !== e.contentId) {
          throw new Error('PAYLOAD_CONTENT_MISMATCH_AT_SEQ:' + e.seq);
        }
        const already = ledger.getEvent(e.eventId);
        if (!already) {
          ledger.db
            .prepare(
              `INSERT INTO events(event_id,project_id,seq,type,parent_event_id,at,content_id,refs,
                 entity_type,entity_key,version,parent_version_event_id,actor,payload)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              e.eventId,
              e.projectId,
              e.seq,
              e.type,
              e.parentEventId,
              e.at,
              e.contentId,
              JSON.stringify(e.refs),
              e.entityType,
              e.entityKey,
              e.version,
              e.parentVersionEventId,
              e.actor,
              canonicalJson(e.payload),
            );
          events++;
        }
        prevEventId = e.eventId;
      }
    }

    // 3) 引用完整性（在目标库内必须都能解析）
    const allEventIds = new Set<string>();
    for (const e of bundle.events) allEventIds.add(e.eventId);
    for (const e of bundle.events) {
      for (const ref of e.refs) {
        if (!allEventIds.has(ref)) throw new Error('MISSING_REFERENCE:' + ref);
      }
    }

    return {
      importedProjects: bundle.projects.length,
      importedContents: contents,
      importedTiles: tiles,
      importedEvents: events,
      verified: true,
    };
  });
}
