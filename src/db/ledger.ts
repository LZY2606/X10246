/**
 * Ledger：事件溯源账本。
 *  - append：原始输入一经提交不可覆盖；修订产生新版本 + parentVersionEventId；
 *  - 内容寻址：相同 canonical 内容/瓦片只存一份；
 *  - 每个事件记录直接来源 refs；查询实体时校验引用存在，缺失即损坏，不回退最新版。
 */
import { openDatabase, type DB } from './sqlite.ts';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts';
import { canonicalJson, contentHash, eventId } from '../domain/hash.ts';
import type {
  ContentRecord,
  EntityType,
  EventRecord,
  EventType,
  ProjectRecord,
} from '../domain/types.ts';

export interface AppendInput {
  type: EventType;
  entity: { type: EntityType; key: string };
  payload: unknown;
  refs?: string[];
  actor?: EventRecord['actor'];
  /** 该实体上一个版本事件（修订/重算时）。 */
  parentVersionEventId?: string | null;
  /** 事件载荷中若包含瓦片，额外登记到 tiles 表去重。 */
  tiles?: unknown[];
}

export class Ledger {
  readonly db: DB;

  constructor(path: string) {
    this.db = openDatabase(path);
    this.db.exec(SCHEMA_SQL);
    this.ensureMeta();
  }

  private ensureMeta(): void {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get('schemaVersion') as
      | { value: string }
      | undefined;
    if (!row) {
      this.db
        .prepare('INSERT INTO meta(key,value) VALUES(?,?)')
        .run('schemaVersion', SCHEMA_VERSION);
      this.db
        .prepare('INSERT INTO meta(key,value) VALUES(?,?)')
        .run('createdAt', new Date(0).toISOString());
    }
  }

  close(): void {
    this.db.close();
  }

  createProject(project: ProjectRecord): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO projects(project_id,name,created_at,scenario_tags) VALUES(?,?,?,?)',
      )
      .run(project.projectId, project.name, project.createdAt, JSON.stringify(project.scenarioTags));
  }

  getProject(projectId: string): ProjectRecord | null {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE project_id=?')
      .get(projectId) as
      | { project_id: string; name: string; created_at: string; scenario_tags: string }
      | undefined;
    if (!row) return null;
    return {
      projectId: row.project_id,
      name: row.name,
      createdAt: row.created_at,
      scenarioTags: JSON.parse(row.scenario_tags),
    };
  }

  listProjects(): ProjectRecord[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as Array<{
      project_id: string;
      name: string;
      created_at: string;
      scenario_tags: string;
    }>;
    return rows.map((r) => ({
      projectId: r.project_id,
      name: r.name,
      createdAt: r.created_at,
      scenarioTags: JSON.parse(r.scenario_tags),
    }));
  }

  private putContent(kind: string, value: unknown): ContentRecord {
    const canonical = canonicalJson(value);
    const id = contentHash(value);
    const exists = this.db.prepare('SELECT 1 FROM contents WHERE content_id=?').get(id);
    if (!exists) {
      this.db
        .prepare('INSERT INTO contents(content_id,kind,canonical,bytes) VALUES(?,?,?,?)')
        .run(id, kind, canonical, Buffer.byteLength(canonical, 'utf8'));
    }
    return { contentId: id, kind, canonical, bytes: Buffer.byteLength(canonical, 'utf8') };
  }

  putTile(value: unknown): string {
    const canonical = canonicalJson(value);
    const id = contentHash(value);
    const exists = this.db.prepare('SELECT 1 FROM tiles WHERE content_id=?').get(id);
    if (!exists) {
      this.db
        .prepare('INSERT INTO tiles(content_id,canonical,bytes) VALUES(?,?,?)')
        .run(id, canonical, Buffer.byteLength(canonical, 'utf8'));
    }
    return id;
  }

  getTile(contentId: string): unknown | null {
    const row = this.db.prepare('SELECT canonical FROM tiles WHERE content_id=?').get(contentId) as
      | { canonical: string }
      | undefined;
    return row ? JSON.parse(row.canonical) : null;
  }

  getContent(contentId: string): ContentRecord | null {
    const row = this.db
      .prepare('SELECT content_id,kind,canonical,bytes FROM contents WHERE content_id=?')
      .get(contentId) as
      | { content_id: string; kind: string; canonical: string; bytes: number }
      | undefined;
    if (!row) return null;
    return { contentId: row.content_id, kind: row.kind, canonical: row.canonical, bytes: row.bytes };
  }

  nextSeq(projectId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq),-1)+1 AS s FROM events WHERE project_id=?')
      .get(projectId) as { s: number };
    return typeof row.s === 'number' ? row.s : Number(row.s);
  }

  headEventId(projectId: string): string | null {
    const row = this.db
      .prepare('SELECT event_id FROM events WHERE project_id=? ORDER BY seq DESC LIMIT 1')
      .get(projectId) as { event_id: string } | undefined;
    return row ? row.event_id : null;
  }

  currentVersion(projectId: string, type: EntityType | string, key: string): number {
    const row = this.db
      .prepare(
        'SELECT MAX(version) AS v FROM events WHERE project_id=? AND entity_type=? AND entity_key=?',
      )
      .get(projectId, type, key) as { v: number | null } | undefined;
    return row?.v ?? -1;
  }

  /** 追加事件。clock 注入虚拟时间。原始输入不可覆盖：同内容复用 contentId，但事件仍只追加。 */
  append(
    projectId: string,
    input: AppendInput,
    clock: () => string,
  ): EventRecord {
    return this.db.transaction(() => {
      const project = this.getProject(projectId);
      if (!project) throw new Error('UNKNOWN_PROJECT:' + projectId);

      // 登记瓦片（共享片段物理去重）
      if (input.tiles) for (const t of input.tiles) this.putTile(t);

      const content = this.putContent(input.entity.type, input.payload);
      const seq = this.nextSeq(projectId);
      const parentEventId = this.headEventId(projectId);
      const version = this.currentVersion(projectId, input.entity.type, input.entity.key) + 1;
      const parentVersionEventId =
        input.parentVersionEventId ?? this.latestEntityEventId(projectId, input.entity.type, input.entity.key);
      const id = eventId({
        type: input.type,
        projectId,
        seq,
        parentEventId,
        payloadContentId: content.contentId,
      });
      const record: EventRecord = {
        eventId: id,
        projectId,
        seq,
        type: input.type,
        parentEventId,
        at: clock(),
        contentId: content.contentId,
        refs: input.refs ?? [],
        entity: input.entity,
        version,
        parentVersionEventId,
        actor: input.actor ?? 'human',
        payload: input.payload,
      };
      this.db
        .prepare(
          `INSERT INTO events(event_id,project_id,seq,type,parent_event_id,at,content_id,refs,
             entity_type,entity_key,version,parent_version_event_id,actor,payload)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          record.eventId,
          record.projectId,
          record.seq,
          record.type,
          record.parentEventId,
          record.at,
          record.contentId,
          JSON.stringify(record.refs),
          record.entity.type,
          record.entity.key,
          record.version,
          record.parentVersionEventId,
          record.actor,
          canonicalJson(record.payload),
        );
      return record;
    });
  }

  latestEntityEventId(projectId: string, type: EntityType, key: string): string | null {
    const row = this.db
      .prepare(
        'SELECT event_id FROM events WHERE project_id=? AND entity_type=? AND entity_key=? ORDER BY version DESC LIMIT 1',
      )
      .get(projectId, type, key) as { event_id: string } | undefined;
    return row ? row.event_id : null;
  }

  getEvent(eventId: string): EventRecord | null {
    return this.#rowToEvent(
      this.db.prepare('SELECT * FROM events WHERE event_id=?').get(eventId) as
        | EventRow
        | undefined,
    );
  }

  listEvents(projectId: string): EventRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE project_id=? ORDER BY seq ASC')
      .all(projectId) as EventRow[];
    return rows.map((r) => this.#rowToEvent(r)!).filter(Boolean);
  }

  #rowToEvent(row?: EventRow): EventRecord | null {
    if (!row) return null;
    return {
      eventId: row.event_id,
      projectId: row.project_id,
      seq: row.seq,
      type: row.type as EventType,
      parentEventId: row.parent_event_id,
      at: row.at,
      contentId: row.content_id,
      refs: JSON.parse(row.refs),
      entity: { type: row.entity_type as EntityType, key: row.entity_key },
      version: row.version,
      parentVersionEventId: row.parent_version_event_id,
      actor: row.actor as EventRecord['actor'],
      payload: JSON.parse(row.payload),
    };
  }

  allTiles(): Array<{ content_id: string; canonical: string }> {
    return this.db.prepare('SELECT content_id, canonical FROM tiles').all() as Array<{
      content_id: string;
      canonical: string;
    }>;
  }
}

interface EventRow {
  event_id: string;
  project_id: string;
  seq: number;
  type: string;
  parent_event_id: string | null;
  at: string;
  content_id: string;
  refs: string;
  entity_type: string;
  entity_key: string;
  version: number;
  parent_version_event_id: string | null;
  actor: string;
  payload: string;
}
