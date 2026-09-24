import { api } from './api.js';
import { drawGrid, overlayCuts } from './render.js';

const SECTIONS = [
  ['import', '① 导入'],
  ['baseline', '② 基线核对'],
  ['workbench', '③ 展开工作台'],
  ['decisions', '④ 裁定与锁定'],
  ['history', '⑤ 历史重放'],
  ['export', '⑥ 导出 / 导入'],
] as const;

type SectionId = (typeof SECTIONS)[number][1] extends never ? never : (typeof SECTIONS)[number][0];

const state: {
  section: SectionId;
  entities: any[];
  results: any[];
  events: any[];
  locks: any[];
  selectedCandidate: string | null;
  selectedHeight: any | null;
  replay: any | null;
  flash: string;
  flashOk: boolean;
} = {
  section: 'import',
  entities: [],
  results: [],
  events: [],
  locks: [],
  selectedCandidate: null,
  selectedHeight: null,
  replay: null,
  flash: '',
  flashOk: true,
};

const main = document.getElementById('main')!;
const nav = document.getElementById('nav')!;
const flash = document.getElementById('flash')!;

function setFlash(msg: string, okFlag = true) {
  state.flash = msg;
  state.flashOk = okFlag;
  flash.textContent = msg;
  flash.className = okFlag ? 'okmsg' : 'err';
}

async function refresh() {
  const [entities, results, events, locks] = await Promise.all([
    api('GET', '/inputs'),
    api('GET', '/results'),
    api('GET', '/events'),
    api('GET', '/locks'),
  ]);
  state.entities = entities;
  state.results = results;
  state.events = events;
  state.locks = locks;
}

function el(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.append(c);
  return e;
}

function tag(status: string): HTMLElement {
  return el('span', { class: `tag ${status}` }, status);
}

function renderNav() {
  nav.innerHTML = '';
  for (const [id, label] of SECTIONS) {
    const b = el('button', state.section === id ? { class: 'active' } : {}, label);
    b.onclick = () => {
      state.section = id as SectionId;
      render();
    };
    nav.append(b);
  }
}

async function guard(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e: any) {
    const diags = e?.payload?.diagnostics?.join('\n');
    setFlash(`${e.message}${diags ? '\n' + diags : ''}`, false);
  }
}

// ---------- ① 导入 ----------
function viewImport(sec: HTMLElement) {
  const card = el('div', { class: 'card' });
  card.append(el('h3', {}, '离线案例包：干涉条纹簿'));
  const loadBtn = el('button', {}, '加载仓库内案例包（基线 + 修订 + 七情形重放）');
  loadBtn.onclick = () =>
    guard(async () => {
      const r = await api('POST', '/case/load');
      await refresh();
      setFlash(`案例包已重放：实体 ${r.entities}，结果 ${r.results}，事件 ${r.events}，情形 ${r.scenarioCoverage.length}/7`);
      render();
    });
  card.append(loadBtn);

  const paste = el('div', { class: 'card' });
  paste.append(el('h3', {}, '粘贴小型样例（JSON）'));
  const kind = el('select', {}) as HTMLSelectElement;
  for (const k of ['wrapped_phase', 'quality_map', 'invalid_mask', 'wavelength', 'incidence_geometry', 'calibration_plane', 'cut_edit_history'])
    kind.append(el('option', { value: k }, k));
  const entity = el('input', { placeholder: 'entityId（留空自动生成）' }) as HTMLInputElement;
  const ta = el('textarea', { placeholder: '{"width":4,"height":3,"data":[...]}' }) as HTMLTextAreaElement;
  const commit = el('button', {}, '提交为不可变原始输入');
  const out = el('pre', { class: 'mono' });
  commit.onclick = () =>
    guard(async () => {
      const content = JSON.parse(ta.value);
      const r = await api('POST', '/inputs', {
        kind: kind.value,
        entityId: entity.value || undefined,
        content,
        meta: { source: 'paste' },
      });
      await refresh();
      out.textContent = JSON.stringify(r, null, 1);
      setFlash(`已提交 ${r.entityId}@v${r.versionNo}（不可覆盖）`);
      render();
    });
  paste.append(kind, ' ', entity, ta, commit, out);
  sec.append(card, paste);
}

// ---------- ② 基线核对 ----------
function viewBaseline(sec: HTMLElement) {
  const card = el('div', { class: 'card' });
  card.append(el('h3', {}, '输入实体（原相位像素 / 信噪评分 / 无效遮罩 / 波长 / 入射几何 / 标定面 / 切口编辑历史，均不可覆盖）'));
  const table = el('table');
  table.append(el('tr', {}, el('th', {}, '实体'), el('th', {}, '种类'), el('th', {}, '版本（父版本 → 摘要）'), el('th', {}, '操作')));
  for (const e of state.entities) {
    const vers = el('td');
    for (const v of e.versions) {
      vers.append(el('div', { class: 'mono' }, `v${v.versionNo} ← v${v.parentVersionNo ?? '∅'} · ${v.digest.slice(0, 18)}…`));
    }
    const tryOverwrite = el('button', {}, '尝试覆盖（应被拒绝）');
    tryOverwrite.onclick = async () => {
      try {
        const latest = await api('GET', `/inputs/${e.entityId}`);
        await api('POST', '/inputs', { kind: e.kind, entityId: e.entityId, content: latest.content });
        setFlash('覆盖未被拒绝——这不应发生', false);
      } catch (err: any) {
        setFlash(`覆盖被拒绝（符合预期）：${err.message}`, true);
      }
    };
    table.append(el('tr', {}, el('td', { class: 'mono' }, e.entityId), el('td', {}, e.kind), vers, el('td', {}, tryOverwrite)));
  }
  card.append(table);
  sec.append(card);
}

// ---------- ③ 展开工作台 ----------
async function candidateDims(result: any): Promise<{ width: number; height: number }> {
  const ref = result.sourceRefs[0];
  const v = await api('GET', `/inputs/${ref.entityId}/${ref.versionNo}`);
  return { width: v.content.width, height: v.content.height };
}

function viewWorkbench(sec: HTMLElement) {
  const runCard = el('div', { class: 'card' });
  runCard.append(el('h3', {}, '运行展开（生成整周候选，全部保留）'));
  const byKind = (k: string) => state.entities.filter((e) => e.kind === k);
  const mk = (k: string) => {
    const s = el('select') as HTMLSelectElement;
    for (const e of byKind(k)) {
      const latest = e.versions[e.versions.length - 1];
      s.append(el('option', { value: `${e.entityId}@${latest.versionNo}` }, `${e.entityId}@v${latest.versionNo}`));
    }
    return s;
  };
  const phaseSel = mk('wrapped_phase');
  const qualSel = mk('quality_map');
  const maskSel = mk('invalid_mask');
  const parse = (s: HTMLSelectElement) => {
    const [entityId, v] = s.value.split('@');
    return { entityId, versionNo: Number(v) };
  };
  const runBtn = el('button', {}, '展开 → 候选');
  runBtn.onclick = () =>
    guard(async () => {
      const r = await api('POST', '/unwrap', {
        refs: { wrappedPhase: parse(phaseSel), quality: parse(qualSel), invalidMask: parse(maskSel) },
      });
      await refresh();
      state.selectedCandidate = r.candidateIds[0] ?? state.selectedCandidate;
      setFlash(`生成 ${r.candidateIds.length} 个候选（含路径指纹与循环残差）`);
      render();
    });
  runCard.append('相位 ', phaseSel, ' 质量 ', qualSel, ' 遮罩 ', maskSel, ' ', runBtn);

  const listCard = el('div', { class: 'card' });
  listCard.append(el('h3', {}, '整周候选（被采纳与未采纳都保留）'));
  const cands = state.results.filter((r) => r.kind === 'unwrap_candidate');
  const table = el('table');
  table.append(
    el('tr', {}, el('th', {}, '结果'), el('th', {}, '状态'), el('th', {}, '算法/参数指纹'), el('th', {}, '诊断'), el('th', {}, '来源')),
  );
  for (const r of cands) {
    const pick = el('button', {}, state.selectedCandidate === r.resultId ? '✔ 当前' : '查看');
    pick.onclick = () => {
      state.selectedCandidate = r.resultId;
      render();
    };
    table.append(
      el('tr', {},
        el('td', { class: 'mono' }, r.resultId, ' ', pick),
        el('td', {}, tag(r.status)),
        el('td', { class: 'mono' }, `${r.algorithmVersion} · ${r.paramFingerprint.slice(0, 14)}…`),
        el('td', {}, r.diagnosis ?? '—'),
        el('td', { class: 'mono' }, r.sourceRefs.map((s: any) => `${s.entityId}@v${s.versionNo}`).join(', ')),
      ),
    );
  }
  listCard.append(table);
  sec.append(runCard, listCard);

  const detail = el('div', { class: 'card' });
  detail.append(el('h3', {}, '并排复核：包裹 / 展开相位 · 质量图 · 切口网络 · 循环残差 · 高度转换链'));
  sec.append(detail);
  if (!state.selectedCandidate) {
    detail.append(el('div', {}, '请选择一个候选。'));
    return;
  }
  guard(async () => {
    const r = await api('GET', `/results/${state.selectedCandidate}`);
    const dims = await candidateDims(r);
    const c = r.content as any;
    const row = el('div', { class: 'row' });
    const mkPanel = (title: string) => {
      const p = el('div', { class: 'panel' });
      p.append(el('h4', {}, title));
      row.append(p);
      return p;
    };
    const phaseRef = r.sourceRefs[0];
    const phaseV = await api('GET', `/inputs/${phaseRef.entityId}/${phaseRef.versionNo}`);
    const p1 = mkPanel(`包裹相位 (rad) · ${phaseRef.entityId}@v${phaseRef.versionNo}`);
    const cv1 = el('canvas') as HTMLCanvasElement;
    drawGrid(cv1, phaseV.content, 'cyclic');
    p1.append(cv1);

    const p2 = mkPanel(`展开相位 (rad) · ${r.resultId}`);
    const cv2 = el('canvas') as HTMLCanvasElement;
    drawGrid(cv2, { ...dims, data: c.unwrapped }, 'linear', { unknownCells: c.unknownCells });
    p2.append(cv2, el('div', { class: 'mono' }, `unknown(不猜相位): ${c.unknownCells.length} 像素 · 分量 ${c.componentCount}`));

    const qualRef = r.sourceRefs[1];
    const qualV = await api('GET', `/inputs/${qualRef.entityId}/${qualRef.versionNo}`);
    const p3 = mkPanel(`质量图 (score) · ${qualRef.entityId}@v${qualRef.versionNo}`);
    const cv3 = el('canvas') as HTMLCanvasElement;
    drawGrid(cv3, qualV.content, 'gray');
    p3.append(cv3);

    const p4 = mkPanel('切口网络（红色=切口，标注整周偏移 k）');
    const cv4 = el('canvas') as HTMLCanvasElement;
    drawGrid(cv4, phaseV.content, 'cyclic');
    overlayCuts(cv4, c.cuts, c.cycles);
    p4.append(cv4, el('div', { class: 'mono' }, `pathHash ${c.pathHash} · consistent ${c.consistent}`));

    detail.append(row);

    const cyc = el('div', { class: 'card' });
    cyc.append(el('h3', {}, `循环残差（${c.cycles.length} 个非零）`));
    const ct = el('table');
    ct.append(el('tr', {}, el('th', {}, '位置'), el('th', {}, '残差（整周）')));
    for (const cy of c.cycles) ct.append(el('tr', {}, el('td', {}, `(${cy.x},${cy.y})`), el('td', {}, String(cy.residue))));
    cyc.append(c.cycles.length ? ct : el('div', {}, '所有环路闭合。'));
    detail.append(cyc);

    const heightCard = el('div', { class: 'card' });
    heightCard.append(el('h3', {}, '高度转换链'));
    const runH = el('button', {}, '计算高度链（波长 → 几何 → 标定面）');
    runH.onclick = () =>
      guard(async () => {
        const latestOf = (kind: string) => {
          const e = state.entities.find((x) => x.kind === kind);
          const v = e.versions[e.versions.length - 1];
          return { entityId: e.entityId, versionNo: v.versionNo };
        };
        const hr = await api('POST', '/height', {
          candidateResultId: r.resultId,
          refs: {
            wavelength: latestOf('wavelength'),
            incidenceGeometry: latestOf('incidence_geometry'),
            calibrationPlane: latestOf('calibration_plane'),
          },
        });
        await refresh();
        state.selectedHeight = hr.resultId;
        setFlash(`高度链已计算：${hr.resultId}`);
        render();
      });
    heightCard.append(runH);
    const heights = state.results.filter((x) => x.kind === 'height_map' && x.sourceRefs[0]?.entityId === r.resultId);
    for (const h of heights) {
      const hv = await api('GET', `/results/${h.resultId}`);
      const hc = hv.content as any;
      const hp = el('div', { class: 'panel' });
      hp.append(el('h4', {}, `${h.resultId} `), tag(h.status));
      const chain = el('div', { class: 'chain' });
      for (const s of hc.steps) chain.append(el('div', {}, `→ ${s.step}: ${s.description}`));
      hp.append(chain);
      if (hc.diagnostics?.length) hp.append(el('div', { class: 'err' }, hc.diagnostics.join('\n')));
      const hcv = el('canvas') as HTMLCanvasElement;
      drawGrid(hcv, { ...dims, data: hc.heightNm }, 'linear');
      hp.append(hcv, el('div', { class: 'mono' }, `单位 ${hc.unit} · 坐标基准 ${hc.frame}`));
      heightCard.append(hp);
    }
    detail.append(heightCard);
  });
}

// ---------- ④ 裁定与锁定 ----------
function viewDecisions(sec: HTMLElement) {
  const card = el('div', { class: 'card' });
  card.append(el('h3', {}, '人工决定（接受 / 否定 / 撤销，全部写入历史）'));
  const cands = state.results.filter((r) => r.kind === 'unwrap_candidate');
  const sel = el('select') as HTMLSelectElement;
  for (const r of cands) sel.append(el('option', { value: r.resultId }, `${r.resultId} (${r.status})`));
  const reason = el('input', { placeholder: '理由（机器可读事件的 reason）', size: '40' }) as HTMLInputElement;
  const mk = (label: string, action: string) => {
    const b = el('button', {}, label);
    b.onclick = () =>
      guard(async () => {
        await api('POST', '/decisions', { resultId: sel.value, action, reason: reason.value || label });
        await refresh();
        setFlash(`决定已记录：${action} ${sel.value}`);
        render();
      });
    return b;
  };
  card.append(sel, ' ', reason, ' ', mk('接受', 'accept'), ' ', mk('否定', 'reject'));

  const undoCard = el('div', { class: 'card' });
  undoCard.append(el('h3', {}, '撤销决定（写反向事件，不删历史）'));
  const decId = el('input', { placeholder: 'decisionId，如 dec-000012' }) as HTMLInputElement;
  const undoBtn = el('button', {}, '撤销');
  undoBtn.onclick = () =>
    guard(async () => {
      await api('POST', `/decisions/${decId.value}/undo`, {});
      await refresh();
      setFlash(`已撤销 ${decId.value}（历史保留）`);
      render();
    });
  undoCard.append(decId, ' ', undoBtn);

  const lockCard = el('div', { class: 'card' });
  lockCard.append(el('h3', {}, '局部锁定（冲突显式表示，双方保留）'));
  const lockSel = el('select') as HTMLSelectElement;
  for (const r of cands) lockSel.append(el('option', { value: r.resultId }, r.resultId));
  const rx = el('input', { placeholder: 'x', size: '3', value: '4' }) as HTMLInputElement;
  const ry = el('input', { placeholder: 'y', size: '3', value: '4' }) as HTMLInputElement;
  const rw = el('input', { placeholder: 'w', size: '3', value: '6' }) as HTMLInputElement;
  const rh = el('input', { placeholder: 'h', size: '3', value: '4' }) as HTMLInputElement;
  const rk = el('input', { placeholder: '{"component:0":1}', size: '18', value: '{"component:0":1}' }) as HTMLInputElement;
  const lockBtn = el('button', {}, '锁定局部解');
  lockBtn.onclick = () =>
    guard(async () => {
      const r = await api('POST', '/locks', {
        resultId: lockSel.value,
        region: { x: +rx.value, y: +ry.value, width: +rw.value, height: +rh.value },
        kOffsets: JSON.parse(rk.value),
      });
      await refresh();
      setFlash(r.conflict ? `锁定冲突：${r.lockId}（双方保留，待解决）` : `已锁定 ${r.lockId}`, !r.conflict);
      render();
    });
  lockCard.append(lockSel, ' 区域 ', rx, ry, rw, rh, ' 整周偏移 ', rk, ' ', lockBtn);

  const lt = el('table');
  lt.append(el('tr', {}, el('th', {}, '锁定'), el('th', {}, '状态'), el('th', {}, '区域'), el('th', {}, '整周偏移'), el('th', {}, '基于候选'), el('th', {}, '操作')));
  for (const l of state.locks) {
    const resolveBtn = el('button', {}, '以此为准解决');
    resolveBtn.onclick = () =>
      guard(async () => {
        const other = state.locks.find((x) => x.lockId !== l.lockId && x.status === 'conflicted');
        if (!other) {
          setFlash('没有与之冲突的锁定', false);
          return;
        }
        await api('POST', '/locks/resolve', { keepLockId: l.lockId, dropLockId: other.lockId, reason: '复核者裁定' });
        await refresh();
        setFlash(`冲突已解决：保留 ${l.lockId}`);
        render();
      });
    lt.append(
      el('tr', {},
        el('td', { class: 'mono' }, l.lockId),
        el('td', {}, tag(l.status)),
        el('td', { class: 'mono' }, JSON.stringify(l.region)),
        el('td', { class: 'mono' }, JSON.stringify(l.kOffsets)),
        el('td', { class: 'mono' }, l.basisResultId ?? '—'),
        el('td', {}, l.status === 'conflicted' ? resolveBtn : ''),
      ),
    );
  }
  lockCard.append(lt);
  sec.append(card, undoCard, lockCard);
}

// ---------- ⑤ 历史重放 ----------
function viewHistory(sec: HTMLElement) {
  const card = el('div', { class: 'card' });
  card.append(el('h3', {}, '事件日志（机器可读；点击事件回到当时状态）'));
  const table = el('table');
  table.append(el('tr', {}, el('th', {}, 'seq'), el('th', {}, '事件'), el('th', {}, '类型'), el('th', {}, '摘要')));
  for (const e of [...state.events].reverse()) {
    const row = el('tr', {},
      el('td', {}, String(e.seq)),
      el('td', { class: 'mono' }, e.eventId),
      el('td', {}, e.type),
      el('td', { class: 'mono' }, JSON.stringify(e.payload).slice(0, 120)),
    );
    row.style.cursor = 'pointer';
    row.onclick = () =>
      guard(async () => {
        state.replay = await api('GET', `/replay/${e.seq}`);
        setFlash(`已回到事件 ${e.eventId} 时的状态（依赖版本与可见结论按当时恢复）`);
        render();
      });
    table.append(row);
  }
  card.append(table);
  sec.append(card);
  if (state.replay) {
    const rp = el('div', { class: 'card' });
    rp.append(el('h3', {}, `状态 @ seq=${state.replay.seq}`));
    const rt = el('table');
    rt.append(el('tr', {}, el('th', {}, '结果'), el('th', {}, '种类'), el('th', {}, '当时状态')));
    for (const r of state.replay.results)
      rt.append(el('tr', {}, el('td', { class: 'mono' }, r.resultId), el('td', {}, r.kind), el('td', {}, tag(r.status))));
    rp.append(rt);
    if (state.replay.locks.length) {
      rp.append(el('h3', {}, '锁定'));
      for (const l of state.replay.locks) rp.append(el('div', { class: 'mono' }, `${l.lockId}: ${l.status}`));
    }
    sec.append(rp);
  }
}

// ---------- ⑥ 导出 / 导入 ----------
function viewExport(sec: HTMLElement) {
  const card = el('div', { class: 'card' });
  card.append(el('h3', {}, '导出 → 删除本地数据库 → 导入（身份、顺序、来源关系保持）'));
  const expBtn = el('button', {}, '导出快照（下载 JSON）');
  expBtn.onclick = () =>
    guard(async () => {
      const dump = await api('GET', '/export');
      const blob = new Blob([JSON.stringify(dump, null, 1)], { type: 'application/json' });
      const a = el('a', { href: URL.createObjectURL(blob), download: 'interference-book-export.json' }) as HTMLAnchorElement;
      a.click();
      setFlash(`已导出：事件 ${dump.tables.events.length}，结果 ${dump.tables.results.length}`);
    });
  const resetBtn = el('button', {}, '删除本地数据库');
  resetBtn.onclick = () =>
    guard(async () => {
      await api('POST', '/dev/reset');
      await refresh();
      setFlash('本地数据库已删除（空库）');
      render();
    });
  const file = el('input', { type: 'file', accept: '.json' }) as HTMLInputElement;
  const impBtn = el('button', {}, '导入快照');
  impBtn.onclick = () =>
    guard(async () => {
      const f = file.files?.[0];
      if (!f) {
        setFlash('请选择导出的 JSON 文件', false);
        return;
      }
      const dump = JSON.parse(await f.text());
      const r = await api('POST', '/import', dump);
      await refresh();
      setFlash(`导入完成：${JSON.stringify(r.imported)}`);
      render();
    });
  card.append(expBtn, ' ', resetBtn, ' ', file, impBtn);
  sec.append(card);
}

// ---------- 框架 ----------
const VIEWS: Record<SectionId, (sec: HTMLElement) => void> = {
  import: viewImport,
  baseline: viewBaseline,
  workbench: viewWorkbench,
  decisions: viewDecisions,
  history: viewHistory,
  export: viewExport,
};

function render() {
  renderNav();
  main.innerHTML = '';
  const sec = el('section', { class: 'active' });
  main.append(sec);
  VIEWS[state.section](sec);
}

(async () => {
  await guard(async () => {
    await refresh();
    setFlash('就绪。可加载案例包或粘贴样例。');
  });
  render();
})();
