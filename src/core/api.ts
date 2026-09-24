/** API 路由：每个显示值都能追到稳定身份、版本号与内容摘要。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { Store, CorruptionError, ImmutabilityError } from "./store";
import { ReviewEngine } from "./engine";
import { validateImport } from "./importer";
import { loadCasePack } from "./casepack";
import { buildCounterexampleArchive } from "./archive";
import { exportBundle, importBundle, type ExportBundle } from "./exportImport";
import { SCENARIOS, INPUT_KINDS } from "../domain/types";
import { DEFAULT_UNWRAP_PARAMS } from "../domain/unwrap";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

interface Ctx {
  db: DatabaseSync;
  store: Store;
  engine: ReviewEngine;
  resetDb: () => void;
  samplesDir: string;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 1);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function handleApi(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://local");
  const path = url.pathname.replace(/^\/api/, "") || "/";
  const method = req.method ?? "GET";
  try {
    // ----- 查询 -----
    if (method === "GET" && path === "/state") {
      const integrity = ctx.store.verifyIntegrity();
      return send(res, 200, {
        entities: ctx.store.listEntities(),
        projection: ctx.engine.projectState(),
        integrity,
        scenarios: SCENARIOS,
        inputKinds: INPUT_KINDS,
        defaultParams: DEFAULT_UNWRAP_PARAMS,
      });
    }
    if (method === "GET" && path === "/events") {
      const upTo = url.searchParams.get("upTo");
      const events = ctx.store.events(upTo ? Number(upTo) : undefined);
      return send(res, 200, { events, projection: ctx.engine.projectState(upTo ? Number(upTo) : undefined) });
    }
    let m = path.match(/^\/entities\/([^/]+)$/);
    if (method === "GET" && m) {
      return send(res, 200, { entityId: m[1], versions: ctx.store.versionHistory(m[1]!) });
    }
    m = path.match(/^\/entities\/([^/]+)\/versions\/(\d+)$/);
    if (method === "GET" && m) {
      const { ref, content } = ctx.store.resolveVersion(m[1]!, Number(m[2]));
      return send(res, 200, { ref, content });
    }
    m = path.match(/^\/results\/([^/]+)$/);
    if (method === "GET" && m) {
      const rec = ctx.store.getDerived(m[1]!);
      return send(res, 200, rec);
    }
    if (method === "GET" && path === "/results") {
      return send(res, 200, { results: ctx.store.listDerived() });
    }
    m = path.match(/^\/samples\/([\w-]+)$/);
    if (method === "GET" && m) {
      const file = join(ctx.samplesDir, `${m[1]}.json`);
      if (!existsSync(file)) return send(res, 404, { error: `样例 ${m[1]} 不存在` });
      return send(res, 200, JSON.parse(readFileSync(file, "utf8")));
    }

    // ----- 命令 -----
    if (method === "POST" && path === "/import") {
      const b = (await body(req)) as { kind: string; payload: unknown; note?: string };
      const v = validateImport(b.kind, b.payload);
      if (!v.ok) return send(res, 422, { errors: v.errors });
      const ref = ctx.engine.importInput(v.kind, v.payload, b.note);
      return send(res, 200, { ref });
    }
    if (method === "POST" && path === "/revise") {
      const b = (await body(req)) as { entityId: string; payload: unknown; note: string };
      const ref = ctx.engine.reviseInput(b.entityId, b.payload, b.note ?? "修订");
      return send(res, 200, { ref });
    }
    if (method === "POST" && path === "/baseline/verify") {
      return send(res, 200, ctx.engine.verifyBaseline());
    }
    if (method === "POST" && path === "/unwrap") {
      const b = (await body(req)) as { params?: typeof DEFAULT_UNWRAP_PARAMS };
      const r = ctx.engine.runUnwrap(b.params);
      return send(res, 200, { resultId: r.resultId, summary: { holes: r.result.holes.length, cuts: r.result.cuts.length, cycles: r.result.cycles.length, candidates: r.result.candidates.map((c) => c.candidateId) } });
    }
    if (method === "POST" && path === "/height") {
      const b = (await body(req)) as { resultId: string; candidateId: string };
      return send(res, 200, ctx.engine.runHeight(b.resultId, b.candidateId));
    }
    if (method === "POST" && path === "/adopt" || method === "POST" && path === "/reject") {
      const b = (await body(req)) as { resultId: string; candidateId: string; reason: string; rules: never[] };
      const id = path === "/adopt"
        ? ctx.engine.adoptCandidate(b.resultId, b.candidateId, b.reason, b.rules ?? [])
        : ctx.engine.rejectCandidate(b.resultId, b.candidateId, b.reason, b.rules ?? []);
      return send(res, 200, { decisionId: id });
    }
    if (method === "POST" && path === "/params") {
      const b = (await body(req)) as { params: typeof DEFAULT_UNWRAP_PARAMS; reason: string };
      const r = ctx.engine.adjustParams(b.params, b.reason);
      return send(res, 200, { resultId: r.resultId });
    }
    if (method === "POST" && path === "/lock") {
      const b = (await body(req)) as { region: number[]; owner: string; candidateId: string };
      return send(res, 200, ctx.engine.acquireLock(b.region, b.owner, b.candidateId));
    }
    if (method === "POST" && path === "/unlock") {
      const b = (await body(req)) as { lockId: string };
      ctx.engine.releaseLock(b.lockId);
      return send(res, 200, { ok: true });
    }
    if (method === "POST" && path === "/undo") {
      const b = (await body(req)) as { seq: number; reason: string };
      ctx.engine.undo(b.seq, b.reason);
      return send(res, 200, { ok: true });
    }
    if (method === "POST" && path === "/scenario") {
      const b = (await body(req)) as { scenario: (typeof SCENARIOS)[number]; affectedEntities?: string[]; inputFragments?: string[] };
      ctx.engine.triggerScenario(b.scenario, b.affectedEntities ?? [], b.inputFragments ?? []);
      return send(res, 200, { ok: true });
    }
    if (method === "POST" && path === "/casepack/load") {
      return send(res, 200, loadCasePack(ctx.engine));
    }
    if (method === "POST" && path === "/archive/build") {
      return send(res, 200, { entries: buildCounterexampleArchive(ctx.engine, ctx.store) });
    }
    if (method === "GET" && path === "/export") {
      return send(res, 200, exportBundle(ctx.db));
    }
    if (method === "POST" && path === "/import-bundle") {
      const b = (await body(req)) as { bundle: ExportBundle; reset: boolean };
      if (b.reset) ctx.resetDb();
      importBundle(ctx.db, ctx.store, b.bundle);
      return send(res, 200, { ok: true, integrity: ctx.store.verifyIntegrity() });
    }
    send(res, 404, { error: `未知路由 ${method} ${path}` });
  } catch (e) {
    if (e instanceof CorruptionError) return send(res, 409, { error: e.message, code: "corruption" });
    if (e instanceof ImmutabilityError) return send(res, 409, { error: e.message, code: "immutable" });
    send(res, 500, { error: (e as Error).message });
  }
}
