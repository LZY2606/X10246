/**
 * HTTP API（挂在 Vite dev server 的 /api 下）。
 * 支持：项目列表、复核数据、实体查询（版本+摘要+引用，损坏即报）、
 *       候选裁定、局部锁定/解锁、撤销、历史快照、导出、导入（删除重建）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getLedger } from './store.ts';
import { projectState, snapshotAt } from '../db/projection.ts';
import { exportProject, importBundle, type ExportBundle } from '../db/bundle.ts';
import { buildReviewData } from './view-data.ts';
import { decideCandidate, lockRegion, unlockRegion, reverseHistory, appendCutEdit } from '../service/decisions.ts';
import { VirtualClock } from '../domain/rng.ts';
import { parseSampleText } from '../service/import-format.ts';
import { ingestScene } from '../service/ingest.ts';
import { runPipeline } from '../service/pipeline.ts';
import { buildCombinedScene } from '../domain/scenarios.ts';
import type { SourceIds } from '../service/pipeline.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL, body: unknown) => unknown;

function send(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const routes: Array<{ method: string; match: (p: string) => RegExpMatchArray | null; handle: Handler }> = [];
function route(method: string, pattern: RegExp, handle: Handler): void {
  routes.push({ method, match: (p) => p.match(pattern), handle });
}

route('GET', /^\/projects$/, (_req, res) => {
  const ledger = getLedger();
  send(res, 200, { projects: ledger.listProjects() });
});

route('GET', /^\/project\/([^/]+)\/review$/, (_req, res, url) => {
  const pid = decodeURIComponent(url.pathname.split('/')[2]);
  const variant = url.searchParams.get('variant') ?? undefined;
  const ledger = getLedger();
  if (!ledger.getProject(pid)) return send(res, 404, { error: 'UNKNOWN_PROJECT' });
  send(res, 200, buildReviewData(ledger, pid, { treeVariant: variant }));
});

route('GET', /^\/project\/([^/]+)\/entity$/, (_req, res, url) => {
  const pid = decodeURIComponent(url.pathname.split('/')[2]);
  const type = url.searchParams.get('type') ?? '';
  const key = url.searchParams.get('key') ?? '';
  const ledger = getLedger();
  const state = projectState(ledger, pid);
  for (const view of state.entities.values()) {
    if (view.type === type && view.key === key) {
      return send(res, 200, {
        type: view.type,
        key: view.key,
        currentVersion: view.currentVersion,
        versions: view.versions.map((v) => ({
          eventId: v.event.eventId,
          seq: v.event.seq,
          version: v.event.version,
          at: v.event.at,
          actor: v.event.actor,
          stale: v.stale,
          contentSummary: v.contentSummary,
          parentVersionEventId: v.event.parentVersionEventId,
          references: v.dependencies.map((d) => ({
            eventId: d.eventId,
            label: d.label,
            missing: d.missing,
            integrity: d.missing ? 'CORRUPT' : 'OK',
          })),
        })),
        corruption: state.corruptions.filter((c) =>
          view.versions.some((v) => v.event.eventId === c.eventId),
        ),
      });
    }
  }
  send(res, 404, { error: 'ENTITY_NOT_FOUND', type, key });
});

route('GET', /^\/project\/([^/]+)\/event\/([^/]+)$/, (_req, res, url) => {
  const parts = url.pathname.split('/');
  const pid = decodeURIComponent(parts[2]);
  const eventId = decodeURIComponent(parts[4]);
  const ledger = getLedger();
  const ev = ledger.getEvent(eventId);
  if (!ev || ev.projectId !== pid) return send(res, 404, { error: 'EVENT_NOT_FOUND' });
  const content = ledger.getContent(ev.contentId);
  const state = projectState(ledger, pid);
  const missing = ev.refs.filter((r) => !state.events.some((e) => e.eventId === r));
  send(res, 200, {
    eventId: ev.eventId,
    seq: ev.seq,
    type: ev.type,
    at: ev.at,
    actor: ev.actor,
    version: ev.version,
    parentVersionEventId: ev.parentVersionEventId,
    refs: ev.refs,
    integrity: missing.length ? 'CORRUPT' : 'OK',
    missingRefs: missing,
    contentId: ev.contentId,
    contentSummary: content ? content.canonical.slice(0, 400) : null,
    payload: ev.payload,
  });
});

route('GET', /^\/project\/([^/]+)\/snapshot$/, (_req, res, url) => {
  const pid = decodeURIComponent(url.pathname.split('/')[2]);
  const seq = Number(url.searchParams.get('seq') ?? '0');
  const ledger = getLedger();
  send(res, 200, snapshotAt(ledger, pid, seq));
});

route('POST', /^\/project\/([^/]+)\/decide$/, (req, res, url, body) => {
  const pid = decodeURIComponent(url.pathname.split('/')[2]);
  const b = body as Record<string, unknown>;
  const ledger = getLedger();
  const clock = new VirtualClock('2026-03-01T00:00:00.000Z', 1000);
  const ev = decideCandidate({
    ledger,
    projectId: pid,
    clock,
    integerCandidatesEventId: String(b.integerCandidatesEventId),
    ambiguityId: String(b.ambiguityId),
    decision: b.decision as 'accept' | 'reject' | 'adjust',
    chosenK: (b.chosenK as number) ?? null,
    rationale: String(b.rationale ?? ''),
    parameterAdjustment: b.parameterAdjustment as never,
  });
  send(res, 200, { eventId: ev.eventId, seq: ev.seq });
});

route('POST', /^\/project\/([^/]+)\/lock$/, (_req, res, url, body) => {
  const pid = decodeURIComponent(url.pathname.split('/')[2]);
  const b = body as Record<string, unknown>;
  const ledger = getLedger();
  const clock = new VirtualClock('2026-03-01T00:00:00.000Z', 1000);
  const ev = lockRegion({
    ledger,
    projectId: pid,
    clock,
    regionId: String(b.regionId),
    interpretation: String(b.interpretation),
    bound: b.bound as never,
    forceResolve: Boolean(b.forceResolve),
  });
  const payload = ev.payload as { status: string; conflictsWith: string[] };
  send(res, 200, { eventId: ev.eventId, status: payload.status, conflictsWith: payload.conflictsWith });
});

route('POST', /^\/project\/([^/]+)\/unlock$/, (_req, res, url, body) => {
  const pid = decodeURIComponent(url.pathname.split('/')[2]);
  const b = body as Record<string, unknown>;
  const ledger = getLedger();
  const clock = new VirtualClock('2026-03-01T00:00:00.000Z', 1000);
  const ev = unlockRegion({
    ledger,
    projectId: pid,
    clock,
    regionId: String(b.regionId),
    reason: String(b.reason ?? ''),
  });
  send(res, 200, { eventId: ev.eventId });
});

route('POST', /^\/project\/([^/]+)\/reverse$/, (_req, res, url, body) => {
  const pid = decodeURIComponent(url.pathname.split('/')[2]);
  const b = body as Record<string, unknown>;
  const ledger = getLedger();
  const clock = new VirtualClock('2026-03-01T00:00:00.000Z', 1000);
  const ev = reverseHistory({
    ledger,
    projectId: pid,
    clock,
    kind: (b.kind as 'undo' | 'rollback') ?? 'undo',
    targetEventId: String(b.targetEventId),
    reason: String(b.reason ?? ''),
  });
  send(res, 200, { eventId: ev.eventId });
});

route('POST', /^\/project\/([^/]+)\/cut$/, (_req, res, url, body) => {
  const pid = decodeURIComponent(url.pathname.split('/')[2]);
  const b = body as Record<string, unknown>;
  const ledger = getLedger();
  const clock = new VirtualClock('2026-03-01T00:00:00.000Z', 1000);
  const ev = appendCutEdit({
    ledger,
    projectId: pid,
    clock,
    edit: {
      action: 'add-cut',
      a: b.a as { r: number; c: number },
      b: b.b as { r: number; c: number },
      reason: String(b.reason ?? 'manual cut'),
      actor: 'human',
    },
  });
  send(res, 200, { eventId: ev.eventId });
});

route('POST', /^\/import-sample$/, async (_req, res, _url, body) => {
  const b = body as { text?: string; projectId?: string; name?: string };
  const parsed = parseSampleText(b.text ?? '');
  if (!parsed.ok) return send(res, 400, { error: 'FORMAT_ERROR', errors: parsed.errors });
  // 用解析样例构造一个组合场景导入并跑流水线（演示自定义导入）。
  const ledger = getLedger();
  const pid = b.projectId || 'proj_custom_' + Date.now();
  if (!ledger.getProject(pid)) {
    ledger.createProject({
      projectId: pid,
      name: b.name ?? '自定义导入',
      createdAt: new Date(0).toISOString(),
      scenarioTags: ['custom-import'],
    });
  }
  const scene = buildCombinedScene([]);
  scene.phase = parsed.sample.phase;
  scene.amplitude = parsed.sample.amplitude;
  scene.snr = parsed.sample.snr;
  scene.mask = parsed.sample.mask;
  const clock = new VirtualClock('2026-03-01T00:00:00.000Z', 1000);
  const ing = ingestScene(ledger, pid, clock, scene);
  const result = runPipeline(ledger, pid, clock, ing.ids as unknown as SourceIds);
  send(res, 200, { projectId: pid, pipeline: result });
});

route('GET', /^\/sample$/, (_req, res) => {
  import('../service/import-format.ts').then((m) => send(res, 200, { text: m.sampleText() }));
});

route('GET', /^\/project\/([^/]+)\/export$/, (_req, res, url) => {
  const pid = decodeURIComponent(url.pathname.split('/')[2]);
  const ledger = getLedger();
  const bundle = exportProject(ledger, pid, new Date(0).toISOString());
  res.setHeader('content-disposition', `attachment; filename="${pid}.irl.json"`);
  send(res, 200, bundle);
});

route('POST', /^\/import-bundle$/, async (_req, res, _url, body) => {
  const ledger = getLedger();
  try {
    const report = importBundle(ledger, body as ExportBundle);
    send(res, 200, report);
  } catch (e) {
    send(res, 400, { error: 'BUNDLE_REJECTED', message: (e as Error).message });
  }
});

export function apiMiddleware() {
  return async (req: IncomingMessage, res: ServerResponse, next?: () => void): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname.replace(/^\/api/, '');
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.match(path);
        if (!m) continue;
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method ?? '') ? await readBody(req) : {};
        await r.handle(req, res, url, body);
        return;
      }
      if (next) return next();
      send(res, 404, { error: 'NOT_FOUND', path });
    } catch (e) {
      send(res, 500, { error: 'INTERNAL', message: (e as Error).message });
    }
  };
}
