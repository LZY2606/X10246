/** 纯函数 API 处理器：vite 中间件与测试共用同一入口。 */
import { CorruptionError, FormatError, ImmutableError, Store } from './store.js';
import { loadCasePack } from './casepack.js';

export interface ApiResponse {
  status: number;
  body: unknown;
}

function ok(body: unknown, status = 200): ApiResponse {
  return { status, body };
}

function err(status: number, message: string, diagnostics?: string[]): ApiResponse {
  return { status, body: { error: message, diagnostics: diagnostics ?? [] } };
}

export function handleApi(store: Store, method: string, path: string, body?: any): ApiResponse {
  try {
    return route(store, method, path, body);
  } catch (e) {
    if (e instanceof FormatError) return err(422, e.message, e.diagnostics);
    if (e instanceof ImmutableError) return err(409, e.message);
    if (e instanceof CorruptionError) return err(409, e.message);
    if (e instanceof Error) return err(500, e.message);
    return err(500, String(e));
  }
}

function route(store: Store, method: string, path: string, body: any): ApiResponse {
  const [cleanPath, query = ''] = path.split('?');
  path = cleanPath;
  const parts = path.split('/').filter(Boolean);

  if (method === 'GET' && path === '/health') return ok({ ok: true });

  if (method === 'POST' && path === '/inputs') {
    return ok(store.commitInput(body), 201);
  }
  if (method === 'GET' && path === '/inputs') return ok(store.listEntities());
  if (method === 'GET' && parts[0] === 'inputs' && parts.length >= 2) {
    // 实体 ID 允许包含 '/'；末段为纯数字时视为版本号。
    const last = parts[parts.length - 1];
    if (parts.length >= 3 && /^\d+$/.test(last)) {
      return ok(store.getEntityVersion(parts.slice(1, -1).join('/'), Number(last)));
    }
    return ok(store.getEntityVersion(parts.slice(1).join('/')));
  }

  if (method === 'POST' && path === '/unwrap') return ok(store.runUnwrap(body), 201);
  if (method === 'POST' && path === '/height') return ok(store.runHeight(body), 201);

  if (method === 'GET' && path === '/results') return ok(store.listResults());
  if (method === 'GET' && parts[0] === 'results' && parts.length === 2) {
    return ok(store.getResult(parts[1]));
  }

  if (method === 'POST' && path === '/decisions') return ok(store.decide(body), 201);
  if (method === 'POST' && parts[0] === 'decisions' && parts[2] === 'undo') {
    return ok(store.undoDecision(parts[1], body?.actor), 201);
  }

  if (method === 'POST' && path === '/locks') return ok(store.lockLocal(body), 201);
  if (method === 'GET' && path === '/locks') return ok(store.listLocks());
  if (method === 'POST' && path === '/locks/resolve') return ok(store.resolveLockConflict(body), 201);

  if (method === 'GET' && parts[0] === 'events') {
    const since = Number(new URLSearchParams(query).get('since') ?? 0);
    return ok(store.listEvents(since));
  }
  if (method === 'GET' && parts[0] === 'replay' && parts.length === 2) {
    return ok(store.stateAt(Number(parts[1])));
  }

  if (method === 'GET' && path === '/export') return ok(store.exportDump());
  if (method === 'POST' && path === '/import') return ok(store.importDump(body), 201);

  if (method === 'POST' && path === '/case/load') return ok(loadCasePack(store), 201);

  return err(404, `no route: ${method} ${path}`);
}
