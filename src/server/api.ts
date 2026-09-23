import type { IncomingMessage, ServerResponse } from 'node:http';
import { rmSync } from 'node:fs';
import { LedgerService } from '../shared/domain/ledger-service';
import { CorruptionError, LedgerStore } from '../shared/store/sqlite-store';

export interface ServerApi {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  close(): void;
  dbPath(): string;
}

export function createServerApi(dbPath: string): ServerApi {
  let service = new LedgerService(new LedgerStore(dbPath), { seed: 20260924 });

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolvePromise, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text) return resolvePromise({});
        try {
          resolvePromise(JSON.parse(text));
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });

  return {
    dbPath: () => dbPath,
    close: () => service.store.close(),

    async handle(req, res) {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const route = `${req.method} ${url.pathname}`;
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method ?? '') ? await readBody(req) : {};

      try {
        switch (route) {
          case 'GET /health':
            return json(res, 200, { ok: true, db: dbPath });

          case 'POST /cases': {
            const result = service.importCase(body);
            return json(res, 200, {
              caseId: result.caseId,
              committed: result.committed.map((c) => ({
                entityId: c.envelope.entityId,
                version: c.envelope.version,
                slot: c.envelope.slot,
                reused: c.reused,
              })),
              warnings: result.warnings,
            });
          }

          case 'GET /cases': {
            const rows = service.store.db
              .prepare("SELECT key, value FROM meta WHERE key LIKE 'case:%' ORDER BY key")
              .all() as { key: string; value: string }[];
            return json(res, 200, rows.map((r) => ({ caseId: r.key.slice(5), label: r.value })));
          }

          case 'POST /recompute': {
            const { caseId } = body as { caseId: string };
            const result = service.commitDerivedPipeline(caseId, 'manual recompute from review UI');
            return json(res, 200, {
              committed: result.committed.map((c) => ({
                entityId: c.envelope.entityId,
                kind: c.envelope.kind,
                reused: c.reused,
              })),
              heights: result.heights.map((h) => h.entityId),
            });
          }

          case 'GET /view': {
            const caseId = url.searchParams.get('caseId') ?? '';
            const atSeq = url.searchParams.get('atSeq');
            const view = service.view(caseId, { atSeq: atSeq ? Number(atSeq) : null });
            return json(res, 200, serializeView(view));
          }

          case 'GET /entity': {
            const entityId = url.searchParams.get('entityId') ?? '';
            const versionParam = url.searchParams.get('version');
            const entity = service.query(entityId, versionParam ? Number(versionParam) : undefined);
            return json(res, 200, serializeEntity(entity));
          }

          case 'GET /history': {
            const entityId = url.searchParams.get('entityId') ?? '';
            return json(res, 200, service.history(entityId).map(serializeEntity));
          }

          case 'POST /rule': {
            const { caseId, candidateSetEntityId, candidateId, decision, reason, author } =
              body as {
                caseId: string;
                candidateSetEntityId: string;
                candidateId: string;
                decision: 'accept' | 'reject';
                reason?: string;
                author?: string;
              };
            const result = service.ruleCandidate(
              caseId,
              candidateSetEntityId,
              candidateId,
              decision,
              reason ?? '',
              author ?? 'reviewer'
            );
            return json(res, 200, { entity: serializeEntity(result.entity), eventId: result.event.eventId });
          }

          case 'POST /lock': {
            const { caseId, pixels, candidateId, lockedValue, interpretation, author } = body as {
              caseId: string;
              pixels: number[];
              candidateId: string | null;
              lockedValue: string;
              interpretation: string;
              author?: string;
            };
            const result = service.acquireLock(
              caseId,
              pixels,
              candidateId ?? null,
              lockedValue,
              interpretation,
              author ?? 'reviewer'
            );
            return json(res, 200, {
              lock: result.lock,
              eventId: result.event.eventId,
              conflict: result.conflict,
            });
          }

          case 'POST /unlock': {
            const { caseId, lockId } = body as { caseId: string; lockId: string };
            const event = service.releaseLock(caseId, lockId);
            return json(res, 200, { eventId: event.eventId });
          }

          case 'POST /cuts': {
            const { caseId, edit, note } = body as {
              caseId: string;
              edit: { a: number; b: number; action: 'add' | 'remove'; reason: string };
              note: string;
            };
            const result = service.appendCutEdit(
              caseId,
              { ...edit, author: 'reviewer' },
              note ?? 'manual cut edit from review UI'
            );
            return json(res, 200, { entityId: result.envelope.entityId, version: result.envelope.version });
          }

          case 'POST /decisions': {
            const { caseId, subject, verdict, rationale, parameterChange, author } = body as {
              caseId: string;
              subject: { kind: never; entityId: string; version: number };
              verdict: 'accepted' | 'rejected' | 'adjusted';
              rationale: string;
              parameterChange?: Record<string, unknown>;
              author?: string;
            };
            const result = service.recordDecision(
              caseId,
              subject,
              verdict,
              rationale,
              parameterChange,
              author ?? 'reviewer'
            );
            return json(res, 200, { decisionId: (result.entity.data as { decisionId: string }).decisionId });
          }

          case 'POST /decisions/undo': {
            const { caseId, decisionId, reason } = body as {
              caseId: string;
              decisionId: string;
              reason: string;
            };
            const event = service.undoDecision(caseId, decisionId, reason);
            return json(res, 200, { eventId: event.eventId });
          }

          case 'POST /revise': {
            const { caseId, slot, data, note } = body as {
              caseId: string;
              slot: Parameters<LedgerService['reviseSlot']>[1];
              data: unknown;
              note: string;
            };
            const result = service.reviseSlot(caseId, slot, data, note);
            return json(res, 200, { entityId: result.envelope.entityId, version: result.envelope.version });
          }

          case 'GET /events': {
            const caseId = url.searchParams.get('caseId') ?? '';
            return json(res, 200, service.events(caseId));
          }

          case 'GET /export': {
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.setHeader('content-disposition', 'attachment; filename="ledger-export.json"');
            res.end(service.store.exportBundle());
            return;
          }

          case 'POST /import-bundle': {
            const text = JSON.stringify(body);
            service.store.close();
            const fresh = new LedgerStore(dbPath);
            const counts = fresh.importBundle(text);
            service = new LedgerService(fresh, { seed: 20260924 });
            return json(res, 200, counts);
          }

          case 'POST /reset-db': {
            service.store.close();
            try {
              rmSync(dbPath, { force: true });
              rmSync(dbPath + '-wal', { force: true });
              rmSync(dbPath + '-shm', { force: true });
            } catch {
              // best effort
            }
            service = new LedgerService(new LedgerStore(dbPath), { seed: 20260924 });
            return json(res, 200, { ok: true });
          }

          default:
            return json(res, 404, { error: 'NotFound', message: route });
        }
      } catch (err) {
        const status =
          err instanceof CorruptionError
            ? 409
            : err && (err as Error).name === 'IngestFormatError'
              ? 422
              : 400;
        return json(res, status, {
          error: err instanceof Error ? err.name : 'Error',
          message: err instanceof Error ? err.message : String(err),
          diagnostics:
            err && typeof err === 'object' && 'diagnostics' in err
              ? (err as { diagnostics: unknown }).diagnostics
              : undefined,
        });
      }
    },
  };
}

function serializeEntity(entity: ReturnType<LedgerService['query']>) {
  return {
    entityId: entity.entityId,
    kind: entity.kind,
    caseId: entity.caseId,
    slot: entity.slot ?? null,
    version: entity.version,
    parentId: entity.parentId,
    blobHash: entity.blobHash,
    refs: entity.refs,
    provenance: entity.provenance ?? {},
    createdAt: entity.createdAt,
    data: entity.data,
  };
}

function serializeView(view: ReturnType<LedgerService['view']>) {
  return {
    caseId: view.caseId,
    atSeq: view.atSeq,
    raws: view.raws.map((r) => ({
      entityId: r.envelope.entityId,
      kind: r.envelope.kind,
      slot: r.envelope.slot,
      version: r.envelope.version,
      parentId: r.envelope.parentId,
      blobHash: r.envelope.blobHash,
      summary: r.summary,
      refs: r.envelope.refs,
      provenance: r.envelope.provenance ?? {},
      createdAt: r.envelope.createdAt,
    })),
    derived: view.derived.map((d) => ({ ...serializeEntity(d.entity), stale: d.stale })),
    locks: view.locks,
    decisions: view.decisions,
    events: view.events,
    currentRawRefs: view.currentRawRefs,
  };
}
