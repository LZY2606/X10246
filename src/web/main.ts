// 复核界面：并排包裹/展开相位、质量图、切口网络、循环残差与高度转换链；
// 任一结果可追到源输入、计算步骤和人工决定；可锁定局部解；可回到任一历史事件。
import './style.css';

interface SourceRef { id: string; kind: string; versionNo: number; contentHash: string }
interface DerivedResult {
  id: string; kind: string; algorithmVersion: string; paramFingerprint: string;
  sources: SourceRef[]; contentHash: string; content: any; status: string;
  pixels: number[] | null; createdSeq: number; createdAt: number;
}
interface InputVersion {
  id: string; kind: string; versionNo: number; parentId: string | null;
  contentHash: string; content: any; submittedAt: number;
}
interface Decision {
  id: string; seq: number; action: string; targetId: string; rationale: string;
  region: { x: number; y: number; width: number; height: number } | null; effective: boolean;
}
interface EventRecord {
  id: string; seq: number; type: string; subjects: string[];
  basis: Record<string, unknown>; snapshot: any; createdAt: number;
}
interface State {
  inputs: { kind: string; latest: InputVersion | null; history: { id: string; versionNo: number }[] }[];
  derived: DerivedResult[];
  decisions: Decision[];
  events: EventRecord[];
  locks: { lockDecisionId: string; candidateId: string; region: any }[];
  adoptedCandidateId: string | null;
}

const KIND_LABEL: Record<string, string> = {
  wrapped_phase: '原相位像素', quality_score: '信噪评分', invalid_mask: '无效遮罩',
  wavelength: '波长', incidence_geometry: '入射几何', calibration_plane: '标定面',
  cut_edit_history: '切口编辑历史',
};
const EVENT_LABEL: Record<string, string> = {
  PHASE_CROSSING_BOUNDARY: '相位跨越边界', LOW_AMPLITUDE_NO_GUESS: '低振幅孔洞(不猜相位)',
  MULTI_COMPONENT_REGION: '多连通区', CYCLE_NONCLOSURE: '循环不闭合',
  WAVELENGTH_VERSION_CHANGE: '波长版本变更', INTEGER_AMBIGUITY: '整周多解',
  LOCAL_LOCK_CONFLICT: '局部锁定冲突', MULTI_TREE_LOCAL_CONSISTENCY: '多树局部一致',
  CUT_OFFSET_EXPLICIT: '切口整周偏移显式', UNIT_UNCONVERTIBLE: '单位不可转换',
  DECISION_RECORDED: '人工决定', DECISION_UNDONE: '撤销', DERIVATION_FAILED: '派生失败',
  CASEPACK_REPLAY: '案例包重放',
};

let state: State | null = null;
let selectedCandidateId: string | null = null;
let viewingEventId: string | null = null;

async function api(path: string, method = 'GET', body?: unknown): Promise<any> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json();
  if (!res.ok) throw Object.assign(new Error(payload.error ?? res.statusText), { payload });
  return payload;
}

function el(tag: string, cls = '', text = ''): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

// 相位色标：-π..π → 蓝-黑-红；null → 深灰（低振幅/遮罩，不猜相位）
function phaseColor(v: number | null, minV: number, maxV: number): [number, number, number] {
  if (v === null || Number.isNaN(v)) return [40, 40, 40];
  const t = (v - minV) / (maxV - minV || 1);
  const r = Math.round(255 * Math.max(0, t - 0.5) * 2);
  const b = Math.round(255 * Math.max(0, 0.5 - t) * 2);
  const g = Math.round(60 * (1 - Math.abs(t - 0.5) * 2));
  return [r, g, b];
}
function grayColor(v: number | null): [number, number, number] {
  if (v === null) return [40, 40, 40];
  const g = Math.round(255 * Math.max(0, Math.min(1, v)));
  return [g, g, g];
}

function drawField(canvas: HTMLCanvasElement, data: (number | null)[], w: number, h: number, color: (v: number | null) => [number, number, number], cuts: [number, number][] = []): void {
  const scale = Math.max(8, Math.floor(360 / Math.max(w, h)));
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext('2d')!;
  for (let i = 0; i < data.length; i++) {
    const [r, g, b] = color(data[i]);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect((i % w) * scale, Math.floor(i / w) * scale, scale, scale);
  }
  ctx.strokeStyle = '#ff0';
  ctx.lineWidth = 2;
  for (const [a, b] of cuts) {
    const ax = a % w, ay = Math.floor(a / w), bx = b % w, by = Math.floor(b / w);
    ctx.beginPath();
    ctx.moveTo((ax + 0.5) * scale, (ay + 0.5) * scale);
    ctx.lineTo((bx + 0.5) * scale, (by + 0.5) * scale);
    ctx.stroke();
  }
}

function renderPanels(root: HTMLElement): void {
  if (!state) return;
  root.innerHTML = '';
  const wrapped = state.inputs.find((i) => i.kind === 'wrapped_phase')?.latest;
  const qualityMap = state.derived.filter((d) => d.kind === 'quality_map' && d.status === 'current').at(-1);
  const candidates = state.derived.filter((d) => d.kind === 'unwrap_candidate');
  const currentCand = candidates.find((c) => c.id === selectedCandidateId)
    ?? candidates.filter((c) => c.status === 'current').at(-1);
  const offsets = state.derived.filter((d) => d.kind === 'integer_offset_set').at(-1);
  const cycles = state.derived.filter((d) => d.kind === 'cycle_residual_set').at(-1);
  const heightMap = state.derived.filter((d) => d.kind === 'height_map' && d.status === 'current').at(-1);

  const grid = el('div', 'panels');
  const panel = (title: string, stale = false): HTMLElement => {
    const p = el('div', 'panel' + (stale ? ' stale' : ''));
    p.append(el('h3', '', title));
    return p;
  };

  // 包裹相位
  if (wrapped) {
    const p = panel(`包裹相位 · ${KIND_LABEL.wrapped_phase} v${wrapped.versionNo}`);
    const c = wrapped.content;
    const cv = document.createElement('canvas');
    drawField(cv, c.data, c.width, c.height, (v) => phaseColor(v, -Math.PI, Math.PI));
    p.append(cv, el('div', 'meta', `id=${wrapped.id} unit=${c.unit} frame=${c.frame}`));
    grid.append(p);
  }
  // 展开相位
  if (currentCand) {
    const cc = currentCand.content;
    const p = panel(`展开相位 · 候选 ${cc.candidateId.slice(0, 18)}… (${currentCand.status === 'stale' ? '已过期' : '当前'})`, currentCand.status === 'stale');
    const vals = cc.unwrapped.filter((v: number | null) => v !== null) as number[];
    const cv = document.createElement('canvas');
    const cutEdges = (offsets?.content.offsets ?? []).map((o: any) => o.edge);
    drawField(cv, cc.unwrapped, wrapped!.content.width, wrapped!.content.height,
      (v) => phaseColor(v, Math.min(...vals), Math.max(...vals)), cutEdges);
    p.append(cv, el('div', 'meta',
      `id=${currentCand.id} tree=${cc.tree} kShift=${cc.kShift} 算法=${currentCand.algorithmVersion} 指纹=${currentCand.paramFingerprint}`));
    grid.append(p);
  }
  // 质量图
  if (qualityMap) {
    const p = panel('质量图（信噪评分规范化）');
    const cv = document.createElement('canvas');
    drawField(cv, qualityMap.content.data, qualityMap.content.width, qualityMap.content.height, grayColor);
    p.append(cv, el('div', 'meta', `id=${qualityMap.id}`));
    grid.append(p);
  }
  // 切口网络 + 整周偏移
  {
    const p = panel('切口网络 · 整周偏移（显式）');
    const list = el('ul', 'kv');
    const offs = offsets?.content.offsets ?? [];
    if (!offs.length) list.append(el('li', '', '（无切口）'));
    for (const o of offs) list.append(el('li', '', `边 ${o.edge[0]}↔${o.edge[1]} : k=${o.k} (explicit)`));
    p.append(list, el('div', 'meta', offsets ? `id=${offsets.id}` : ''));
    grid.append(p);
  }
  // 循环残差
  {
    const p = panel('循环残差');
    const list = el('ul', 'kv');
    const cyc = cycles?.content.cycles ?? [];
    const nz = cyc.filter((c: any) => c.residualTurns !== 0);
    list.append(el('li', '', `基本循环 ${cyc.length} 个，非闭合 ${nz.length} 个`));
    for (const c of nz.slice(0, 8)) list.append(el('li', 'warn', `${c.cycleId}: ${c.residualTurns} 周 (${c.residualRad.toFixed(3)} rad)`));
    p.append(list, el('div', 'meta', cycles ? `id=${cycles.id}` : ''));
    grid.append(p);
  }
  // 高度转换链
  if (heightMap) {
    const p = panel('表面高度（高度转换链末端）');
    const cv = document.createElement('canvas');
    const vals = heightMap.content.data.filter((v: number | null) => v !== null) as number[];
    drawField(cv, heightMap.content.data, heightMap.content.width, heightMap.content.height,
      (v) => phaseColor(v, Math.min(...vals), Math.max(...vals)));
    p.append(cv, el('div', 'meta',
      `id=${heightMap.id} unit=${heightMap.content.unit} λ=${heightMap.content.wavelengthNm}nm θ=${heightMap.content.thetaDeg}° datum=${heightMap.content.datum}`));
    grid.append(p);
  }
  root.append(grid);
}

function renderCandidates(root: HTMLElement): void {
  if (!state) return;
  root.innerHTML = '<h2>展开候选（采纳与未采纳均保留）</h2>';
  const candidates = state.derived.filter((d) => d.kind === 'unwrap_candidate');
  for (const c of candidates) {
    const cc = c.content;
    const row = el('div', 'candidate' + (c.status === 'stale' ? ' stale' : ''));
    const adopted = state.adoptedCandidateId === c.id;
    const rejected = state.decisions.some((d) => d.action === 'reject_candidate' && d.targetId === c.id && d.effective);
    const locked = state.locks.some((l) => l.candidateId === c.id);
    const badge = adopted ? '【已采纳】' : rejected ? '【已否定】' : locked ? '【局部锁定】' : '';
    row.append(el('span', 'cid', `${cc.candidateId.slice(0, 24)}…`));
    row.append(el('span', '', ` 分量${cc.component} 树=${cc.tree} k=${cc.kShift} ${c.status === 'stale' ? '(过期,仅复查)' : '(当前)'} ${badge}`));
    const btn = (label: string, fn: () => Promise<void>) => {
      const b = el('button', '', label) as HTMLButtonElement;
      b.onclick = async () => { await fn(); await refresh(); };
      row.append(b);
    };
    btn('查看', async () => { selectedCandidateId = c.id; await refresh(); });
    btn('追溯', async () => { await showProvenance(c.id); });
    if (c.status === 'current') {
      btn('采纳', async () => { await api('/api/decisions', 'POST', { action: 'accept_candidate', targetId: c.id, rationale: '审阅采纳' }); });
      btn('否定', async () => { await api('/api/decisions', 'POST', { action: 'reject_candidate', targetId: c.id, rationale: '审阅否定' }); });
      btn('锁定局部', async () => {
        await api('/api/decisions', 'POST', { action: 'lock_local', targetId: c.id, rationale: '锁定局部解', region: { x: 2, y: 2, width: 3, height: 3 } });
      });
      btn('高度链', async () => { await api('/api/derive/height', 'POST', { candidateId: c.id }); });
    }
    root.append(row);
  }
}

async function showProvenance(id: string): Promise<void> {
  const view = await api(`/api/entity/${encodeURIComponent(id)}`);
  const box = document.getElementById('provenance')!;
  box.innerHTML = `<h3>追溯：${id}</h3>`;
  const e = view.entity;
  box.append(el('div', 'meta', `表=${view.entityTable} 内容摘要=${(e.contentHash ?? '').slice(0, 16)}…`));
  if (e.algorithmVersion) box.append(el('div', 'meta', `算法版本=${e.algorithmVersion} 参数指纹=${e.paramFingerprint}`));
  const list = el('ul', 'kv');
  for (const ref of view.references) {
    list.append(el('li', '', `来源 ${ref.kind} v${ref.versionNo} id=${ref.id} 摘要=${ref.digest}…`));
  }
  const related = (state?.decisions ?? []).filter((d) => d.targetId === id);
  for (const d of related) {
    list.append(el('li', '', `人工决定 #${d.seq} ${d.action}「${d.rationale}」${d.effective ? '' : '(已撤销)'}`));
  }
  box.append(list);
}

function renderEvents(root: HTMLElement): void {
  if (!state) return;
  root.innerHTML = '<h2>事件流（机器可读判断依据）</h2>';
  for (const ev of [...state.events].reverse()) {
    const row = el('div', 'event' + (viewingEventId === ev.id ? ' active' : ''));
    row.append(el('span', 'seq', `#${ev.seq}`));
    row.append(el('span', 'type', EVENT_LABEL[ev.type] ?? ev.type));
    row.append(el('span', 'basis', JSON.stringify(ev.basis).slice(0, 120)));
    row.onclick = async () => {
      viewingEventId = viewingEventId === ev.id ? null : ev.id;
      await refresh();
    };
    root.append(row);
  }
  if (viewingEventId) {
    void renderEventView(viewingEventId);
  }
}

async function renderEventView(eventId: string): Promise<void> {
  const view = await api(`/api/events/${encodeURIComponent(eventId)}/view`);
  const box = document.getElementById('eventview')!;
  const snap = view.event.snapshot;
  box.innerHTML = `<h3>历史事件 #${view.event.seq} 当时的依赖版本与可见结论</h3>`;
  const list = el('ul', 'kv');
  for (const [kind, id] of Object.entries(snap.inputVersions)) {
    const v = view.resolvedInputs[kind];
    list.append(el('li', '', `${KIND_LABEL[kind] ?? kind}: v${v?.versionNo ?? '?'} id=${id}`));
  }
  list.append(el('li', '', `当时采纳候选: ${snap.adoptedCandidateId ?? '（无）'}`));
  list.append(el('li', '', `当时锁定: ${snap.locks.length} 项；当前候选 ${snap.currentCandidateIds.length}，过期 ${snap.staleCandidateIds.length}`));
  box.innerHTML = '';
  box.append(list);
}
