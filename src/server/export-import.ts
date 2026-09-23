import { contentRef } from '../core/identity.js';

export interface ExportBundle {
  format: 'fringe-ledger-bundle';
  bundleVersion: 1;
  exportedAt: number;
  project: Record<string, unknown>;
  /** Immutable content blobs deduped by sha256; shared fragments occur once. */
  blobs: Array<{ sha256: string; bytes: number; content: unknown }>;
  rawVersions: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  eventReferences: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
  artifactSources: Array<Record<string, unknown>>;
  candidates: Array<Record<string, unknown>>;
  locks: Array<Record<string, unknown>>;
  conflicts: Array<Record<string, unknown>>;
  archiveInputs: Array<Record<string, unknown>>;
  archiveFragments: Array<Record<string, unknown>>;
  archiveJudgments: Array<Record<string, unknown>>;
}

const TABLES = [
  'raw_versions',
  'events',
  'event_references',
  'artifacts',
  'artifact_sources',
  'candidates',
  'locks',
  'conflicts',
  'archive_inputs',
  'archive_fragments',
  'archive_judgments'
] as const;

export function exportBundle(db: import('node:sqlite').DatabaseSync, projectId: string, at: number): ExportBundle {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as Record<string, unknown>;
  const blobSet = new Map<string, { sha256: string; bytes: number; content: unknown }>();
  const rowsByTable: Record<string, Array<Record<string, unknown>>> = {};

  for (const table of TABLES) {
    const rows = db.prepare(`SELECT * FROM ${table} WHERE project_id=? ORDER BY 1,2,3`).all(projectId) as Array<
      Record<string, unknown>
    >;
    rowsByTable[table] = rows;
    if (table === 'raw_versions') {
      for (const row of rows) {
        const content = JSON.parse(row['payload'] as string);
        blobSet.set(row['sha256'] as string, {
          sha256: row['sha256'] as string,
          bytes: row['bytes'] as number,
          content
        });
      }
    }
    if (table === 'artifacts') {
      for (const row of rows) {
        const content = JSON.parse(row['payload'] as string);
        blobSet.set(row['sha256'] as string, {
          sha256: row['sha256'] as string,
          bytes: row['bytes'] as number,
          content
        });
      }
    }
    if (table === 'archive_fragments') {
      for (const row of rows) {
        const content = JSON.parse(row['content'] as string);
        blobSet.set(row['sha256'] as string, {
          sha256: row['sha256'] as string,
          bytes: row['bytes'] as number,
          content
        });
      }
    }
  }

  const strip = (row: Record<string, unknown>) => {
    const { project_id, ...rest } = row;
    void project_id;
    return rest;
  };

  return {
    format: 'fringe-ledger-bundle',
    bundleVersion: 1,
    exportedAt: at,
    project,
    blobs: [...blobSet.values()].sort((a, b) => a.sha256.localeCompare(b.sha256)),
    rawVersions: rowsByTable['raw_versions']!.map(strip),
    events: rowsByTable['events']!.map(strip),
    eventReferences: rowsByTable['event_references']!.map(strip),
    artifacts: rowsByTable['artifacts']!.map(strip),
    artifactSources: rowsByTable['artifact_sources']!.map(strip),
    candidates: rowsByTable['candidates']!.map(strip),
    locks: rowsByTable['locks']!.map(strip),
    conflicts: rowsByTable['conflicts']!.map(strip),
    archiveInputs: rowsByTable['archive_inputs']!.map(strip),
    archiveFragments: rowsByTable['archive_fragments']!.map(strip),
    archiveJudgments: rowsByTable['archive_judgments']!.map(strip)
  };
}

export function importBundle(
  db: import('node:sqlite').DatabaseSync,
  bundle: ExportBundle,
  clock: import('../core/clock.js').VirtualClock
): { projectId: string; integrity: { ok: boolean; broken: Array<{ id: string; reason: string }> } } {
  if (bundle.format !== 'fringe-ledger-bundle' || bundle.bundleVersion !== 1) {
    throw new Error('unsupported bundle format/version');
  }
  const projectId = bundle.project['id'] as string;
  db.exec('DELETE FROM projects WHERE id=?', () => {});
  db.prepare(
    'INSERT OR REPLACE INTO projects(id,name,created_at,clock_now,event_seq,seed) VALUES (?,?,?,?,?,?)'
  ).run(
    projectId,
    bundle.project['name'],
    bundle.project['created_at'],
    bundle.project['clock_now'],
    bundle.project['event_seq'],
    bundle.project['seed']
  );
  clock.set(bundle.project['clock_now'] as number);
  db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run('active_project', projectId);

  // Verify blob digests first: identities must be stable after reimport.
  for (const blob of bundle.blobs) {
    const ref = contentRef(blob.content);
    if (ref.sha256 !== blob.sha256 || ref.bytes !== blob.bytes) {
      throw new Error(`bundle blob digest mismatch for ${blob.sha256}`);
    }
  }

  const insertRows = (table: string, rows: Array<Record<string, unknown>>, columns: string[]) => {
    const placeholders = columns.map(() => '?').join(',');
    const insert = db.prepare(
      `INSERT OR REPLACE INTO ${table}(${['project_id', ...columns].join(',')}) VALUES (${['?', ...placeholders].join(',')})`
    );
    for (const row of rows) insert.run(projectId, ...columns.map((column) => row[column] ?? null));
  };

  insertRows(
    'raw_versions',
    bundle.rawVersions,
    ['lineage', 'version', 'parent_version', 'sha256', 'bytes', 'payload', 'recorded_at', 'submitted_by', 'note']
  );
  insertRows(
    'events',
    bundle.events,
    ['event_id', 'seq', 'type', 'at', 'actor', 'payload', 'parent_event_id', 'seq_order']
  );
  insertRows(
    'event_references',
    bundle.eventReferences,
    ['event_id', 'ref_order', 'kind', 'ref_id', 'version', 'sha256', 'summary']
  );
  insertRows(
    'artifacts',
    bundle.artifacts,
    [
      'artifact_id', 'kind', 'status', 'stale', 'superseded_by', 'algorithm', 'algorithm_version',
      'parameters', 'fingerprint', 'sha256', 'bytes', 'payload', 'diagnostic', 'created_at', 'created_seq'
    ]
  );
  insertRows(
    'artifact_sources',
    bundle.artifactSources,
    ['artifact_id', 'ref_order', 'kind', 'ref_id', 'version', 'sha256', 'summary']
  );
  insertRows(
    'candidates',
    bundle.candidates,
    [
      'candidate_id', 'target', 'target_type', 'offset_cycles', 'status', 'tree_path',
      'cycle_residuals', 'reject_reason', 'created_at', 'created_seq', 'sources'
    ]
  );
  insertRows(
    'locks',
    bundle.locks,
    [
      'lock_id', 'region_id', 'candidate_id', 'locked_offset_cycles', 'decision', 'adjustments',
      'note', 'actor', 'decided_at', 'undone_at', 'resolves_conflict_id', 'sources', 'created_seq'
    ]
  );
  insertRows(
    'conflicts',
    bundle.conflicts,
    [
      'conflict_id', 'kind', 'status', 'description', 'involved_candidates', 'involved_locks',
      'detected_at', 'resolved_at', 'resolution_event_id'
    ]
  );
  insertRows(
    'archive_inputs',
    bundle.archiveInputs,
    [
      'id', 'scenario', 'role', 'interpretation_version', 'interpretation_note', 'diagnostic',
      'adopted', 'accepted', 'decision_note', 'decided_at', 'order_index'
    ]
  );
  insertRows(
    'archive_fragments',
    bundle.archiveFragments,
    ['id', 'ref_order', 'sha256', 'bytes', 'content']
  );
  insertRows(
    'archive_judgments',
    bundle.archiveJudgments,
    ['archive_id', 'order_index', 'criterion', 'passed', 'detail', 'affected', 'expected', 'scenario']
  );

  // Integrity is checked by the store after reopen (see reopenAndVerify).
  return { projectId, integrity: { ok: true, broken: [] } };
}
