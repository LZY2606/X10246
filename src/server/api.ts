import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store';
import { DEFAULT_PARAMS, runHeightDerivation, runUnwrapDerivation } from './derive';
import { replayCasePack } from './casepack';
import { CorruptReferenceError, INPUT_KINDS, type InputKind, type Region } from '../shared/domain';

interface ApiRequest extends IncomingMessage {
  body?: unknown;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return null;
  const text = Buffer.concat(chunks).toString('utf-8');
  return JSON.parse(text);
}

// 导入验证：格式错误明确报诊断；无法转换的值留在原位置，不为画图丢掉。
function validateInput(kind: string, content: unknown): string[] {
  const diagnostics: string[] = [];
  if (!INPUT_KINDS.includes(kind as InputKind)) diagnostics.push(`未知输入实体类型: ${kind}`);
  if (content === null || typeof content !== 'object') {
    diagnostics.push('输入内容必须是对象');
    return diagnostics;
  }
  const c = content as Record<string, unknown>;
  if (kind === 'wrapped_phase' || kind === 'quality_score') {
    if (typeof c.width !== 'number' || typeof c.height !== 'number') diagnostics.push('缺少 width/height');
    if (!Array.isArray(c.data)) diagnostics.push('缺少 data 数组');
    else if (typeof c.width === 'number' && typeof c.height === 'number' && c.data.length !== c.width * c.height) {
      diagnostics.push(`data 长度 ${c.data.length} 与 ${c.width}x${c.height} 不符`);
    }
    if (typeof c.unit !== 'string') diagnostics.push('缺少单位 unit（所有领域量必须携带单位）');
    if (typeof c.frame !== 'string') diagnostics.push('缺少坐标基准 frame');
  }
  if (kind === 'invalid_mask') {
    if (!Array.isArray(c.data)) diagnostics.push('缺少 data 数组');
    if (typeof c.frame !== 'string') diagnostics.push('缺少坐标基准 frame');
  }
  if (kind === 'wavelength') {
    if (typeof c.value !== 'number' || c.value <= 0) diagnostics.push('波长必须是正数');
    if (c.unit !== 'nm' && c.unit !== 'um') diagnostics.push(`无法转换的波长单位: ${String(c.unit)}（值保留在原位置，不做静默换算）`);
  }
  if (kind === 'incidence_geometry') {
    if (typeof c.thetaDeg !== 'number') diagnostics.push('缺少入射角 thetaDeg');
  }
  if (kind === 'calibration_plane') {
    for (const k of ['a', 'b', 'c']) if (typeof c[k] !== 'number') diagnostics.push(`标定面缺少系数 ${k}`);
  }
  if (kind === 'cut_edit_history') {
    if (!Array.isArray(c.segments)) diagnostics.push('切口编辑历史缺少 segments 数组');
  }
  return diagnostics;
}

export function createApiHandler(store: Store) {
  return async function handler(req: ApiRequest, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    try {
      if (method === 'GET' && path === '/api/state') {
        return sendJson(res, 200, {
          inputs: INPUT_KINDS.map((kind) => ({
            kind,
            latest: store.latestInput(kind),
            history: store.inputHistory(kind).map((v) => ({
              id: v.id, versionNo: v.versionNo, parentId: v.parentId, contentHash: v.contentHash,
            })),
          })),
          derived: store.allDerived(),
          decisions: store.decisions(),
          events: store.events(),
          locks: store.effectiveLocks(),
          adoptedCandidateId: store.adoptedCandidateId(),
          snapshot: store.currentSnapshot('api-state'),
        });
      }
      if (method === 'POST' && path === '/api/inputs') {
        const body = (await readBody(req)) as { kind: string; content: unknown; affectedRegion?: Region };
        const diagnostics = validateInput(body.kind, body.content);
        if (diagnostics.length) return sendJson(res, 422, { error: 'INVALID_INPUT', diagnostics });
        const version = store.submitInput(body.kind as InputKind, body.content, body.affectedRegion ?? null);
        return sendJson(res, 201, version);
      }
      if (method === 'POST' && path === '/api/derive/unwrap') {
        return sendJson(res, 200, runUnwrapDerivation(store, DEFAULT_PARAMS));
      }
      if (method === 'POST' && path === '/api/derive/height') {
        const body = (await readBody(req)) as { candidateId: string };
        return sendJson(res, 200, runHeightDerivation(store, body.candidateId));
      }
      if (method === 'POST' && path === '/api/decisions') {
        const body = (await readBody(req)) as {
          action: never; targetId: string; rationale: string; region?: Region;
        };
        const decision = store.recordDecision(body.action, body.targetId, body.rationale ?? '', body.region ?? null);
        return sendJson(res, 201, decision);
      }
      if (method === 'GET' && path.startsWith('/api/entity/')) {
        const id = decodeURIComponent(path.slice('/api/entity/'.length));
        return sendJson(res, 200, store.entity(id));
      }
      if (method === 'GET' && path.startsWith('/api/events/') && path.endsWith('/view')) {
        const id = decodeURIComponent(path.slice('/api/events/'.length, -'/view'.length));
        return sendJson(res, 200, store.eventView(id));
      }
      if (method === 'GET' && path === '/api/export') {
        return sendJson(res, 200, store.exportAll());
      }
      if (method === 'POST' && path === '/api/import') {
        const body = (await readBody(req)) as Record<string, unknown>;
        return sendJson(res, 200, store.importAll(body));
      }
      if (method === 'POST' && path === '/api/reset') {
        store.reset();
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'POST' && path === '/api/casepack/replay') {
        return sendJson(res, 200, replayCasePack(store));
      }
      sendJson(res, 404, { error: 'NOT_FOUND', path });
    } catch (err) {
      if (err instanceof CorruptReferenceError) {
        // 缺少引用必须报损坏，不能退回当前最新版
        return sendJson(res, 409, { error: 'CORRUPT_REFERENCE', missing: err.missing });
      }
      sendJson(res, 500, { error: String((err as Error).message ?? err) });
    }
  };
}
