/** 为复核界面组装带稳定身份的可显示数据（每个显示值都带 id/版本/来源）。 */
import type { Ledger } from '../db/ledger.ts';
import { projectState, type EntityView } from '../db/projection.ts';
import { loadSingleFrame } from '../service/readers.ts';
import type {
  CutNetworkContent,
  HeightChainContent,
  IntegerCandidatesContent,
  QualityMapContent,
  RegionMapContent,
  ResidueMapContent,
  UnwrapTreeContent,
} from '../domain/types.ts';

export interface GridCell {
  id: string; // 稳定身份：eventId:version:r:c
  r: number;
  c: number;
  value: number | null;
  unit: string;
  sourceEventId: string;
  version: number;
  stale: boolean;
}

function eventGrid(
  ledger: Ledger,
  view: EntityView,
  frameEventId: string,
  unit: string,
  values: Float64Array,
  rows: number,
  cols: number,
  stale: boolean,
): { id: string; unit: string; cells: GridCell[]; rows: number; cols: number; stale: boolean } {
  const ev = view.versions[view.versions.length - 1].event;
  const cells: GridCell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = values[r * cols + c];
      cells.push({
        id: `${frameEventId}#v${ev.version}:${r}:${c}`,
        r,
        c,
        value: Number.isFinite(v) ? Number(v.toFixed(5)) : null,
        unit,
        sourceEventId: frameEventId,
        version: ev.version,
        stale,
      });
    }
  }
  return { id: frameEventId, unit, cells, rows, cols, stale };
}

/** 把 'frame:id1,id2' 的瓦片引用还原成栅格。 */
function composedFrame(ledger: Ledger, ref: string, rows: number, cols: number): Float64Array {
  const ids = ref.startsWith('frame:') ? ref.slice(6).split(',').filter(Boolean) : [];
  const out = new Float64Array(rows * cols).fill(NaN);
  for (const tileId of ids) {
    const tile = ledger.getTile(tileId) as {
      blockR: number;
      blockC: number;
      tileRows: number;
      tileCols: number;
      values: number[];
    } | null;
    if (!tile) continue;
    let i = 0;
    for (let r = 0; r < tile.tileRows; r++) {
      for (let c = 0; c < tile.tileCols; c++) {
        out[(tile.blockR * 4 + r) * cols + (tile.blockC * 4 + c)] = tile.values[i++];
      }
    }
  }
  return out;
}

export interface ReviewData {
  projectId: string;
  headSeq: number;
  corruptions: Array<{ eventId: string; missingRef: string; message: string }>;
  inputs: Array<EntitySummary>;
  panels: {
    wrapped?: GridPanel;
    unwrapped?: GridPanel;
    quality?: GridPanel;
    cuts?: CutPanel;
    cycles?: CyclePanel;
    heightSteps?: HeightPanel;
  };
  ambiguities?: AmbiguityPanel;
  regions?: RegionPanel;
  locks?: Array<Record<string, unknown>>;
  history: Array<Record<string, unknown>>;
}

export interface EntitySummary {
  type: string;
  key: string;
  currentVersion: number;
  eventId: string;
  stale: boolean;
  summary: string;
}

export interface GridPanel {
  id: string;
  title: string;
  unit: string;
  rows: number;
  cols: number;
  cells: GridCell[];
  stale: boolean;
}
export interface CutPanel {
  id: string;
  cuts: Array<{ id: string; a: { r: number; c: number }; b: { r: number; c: number }; offset: number | null; kind: string }>;
}
export interface CyclePanel {
  id: string;
  residuals: Array<{ id: string; closed: boolean; residual: number; at: { r: number; c: number } }>;
}
export interface HeightPanel {
  id: string;
  steps: Array<{ index: number; operation: string; formula: string; unit: string; diagnostic: string | null }>;
  height: GridPanel;
}
export interface AmbiguityPanel {
  id: string;
  options: Array<{
    ambiguityId: string;
    location: { r: number; c: number };
    nonUnique: boolean;
    kind: string;
    options: Array<{ k: number; legal: boolean; adopted: boolean; rejectReason: string | null }>;
  }>;
}
export interface RegionPanel {
  id: string;
  regions: Array<{ regionId: string; size: number; hole: boolean; holes: number }>;
}

export function buildReviewData(
  ledger: Ledger,
  projectId: string,
  opts: { treeVariant?: string } = {},
): ReviewData {
  const state = projectState(ledger, projectId);
  const inputs: EntitySummary[] = [];
  const inputTypes = [
    'wrappedPhaseFrame',
    'amplitudeFrame',
    'qualityScoreFrame',
    'invalidMaskFrame',
    'wavelength',
    'incidenceGeometry',
    'calibrationSurface',
    'cutEditHistory',
  ];
  for (const view of state.entities.values()) {
    if (inputTypes.includes(view.type)) {
      const vv = view.versions[view.versions.length - 1];
      inputs.push({
        type: view.type,
        key: view.key,
        currentVersion: view.currentVersion,
        eventId: vv.event.eventId,
        stale: vv.stale,
        summary: vv.contentSummary,
      });
    }
  }

  const panels: ReviewData['panels'] = {};
  const rows = 8;
  const cols = 8;

  // wrapped
  const phaseView = findView(state.entities, 'wrappedPhaseFrame', 'wrappedPhase');
  if (phaseView) {
    const vv = phaseView.versions[phaseView.versions.length - 1];
    const ras = loadSingleFrame(ledger, vv.event.eventId);
    panels.wrapped = asGrid('包裹相位', eventGrid(ledger, phaseView, vv.event.eventId, 'rad', ras, rows, cols, vv.stale));
  }

  // quality
  const qView = findView(state.entities, 'qualityMap', 'main');
  if (qView) {
    const vv = qView.versions[qView.versions.length - 1];
    const p = vv.event.payload as QualityMapContent;
    const ras = composedFrame(ledger, p.scoreContentId, rows, cols);
    panels.quality = asGrid('质量图', eventGrid(ledger, qView, vv.event.eventId, 'score[0,1]', ras, rows, cols, vv.stale));
  }

  // choose unwrap tree
  const treeViews = [...state.entities.values()].filter((v) => v.type === 'unwrapTree');
  const variant = opts.treeVariant ?? 'mst-quality';
  const chosen =
    treeViews.find((v) => v.key.endsWith(':' + variant)) ?? treeViews[0];
  if (chosen) {
    const vv = chosen.versions[chosen.versions.length - 1];
    const tp = vv.event.payload as UnwrapTreeContent;
    const ras = composedFrame(ledger, tp.unwrappedContentId, rows, cols);
    panels.unwrapped = asGrid(
      `展开相位·${tp.treeVariant}`,
      eventGrid(ledger, chosen, vv.event.eventId, 'rad', ras, rows, cols, vv.stale),
    );
    panels.cycles = {
      id: vv.event.eventId,
      residuals: tp.cycleResiduals.map((c) => ({
        id: vv.event.eventId + ':' + c.cycleId,
        closed: c.closed,
        residual: Number(c.residualTurns.toFixed(4)),
        at: c.vertices[0],
      })),
    };
  }

  // cuts
  const cutView = findView(state.entities, 'cutNetwork', 'main');
  if (cutView) {
    const vv = cutView.versions[cutView.versions.length - 1];
    const cp = vv.event.payload as CutNetworkContent;
    panels.cuts = {
      id: vv.event.eventId,
      cuts: cp.cuts.map((c) => ({
        id: vv.event.eventId + ':' + c.cutId,
        a: c.a,
        b: c.b,
        offset: c.integerOffsetTurns,
        kind: c.kind,
      })),
    };
  }

  // regions
  const regView = findView(state.entities, 'regionMap', 'main');
  let regions: RegionPanel | undefined;
  if (regView) {
    const vv = regView.versions[regView.versions.length - 1];
    const rp = vv.event.payload as RegionMapContent;
    regions = {
      id: vv.event.eventId,
      regions: rp.regions.map((r) => ({
        regionId: r.regionId,
        size: r.pixels.length,
        hole: r.containsHole,
        holes: r.holes.length,
      })),
    };
  }

  // ambiguities (of chosen tree)
  let ambiguities: AmbiguityPanel | undefined;
  if (chosen) {
    const intView = [...state.entities.values()].find(
      (v) => v.type === 'integerCandidates' && v.key === chosen.key,
    );
    if (intView) {
      const vv = intView.versions[intView.versions.length - 1];
      const ip = vv.event.payload as IntegerCandidatesContent;
      ambiguities = {
        id: vv.event.eventId,
        options: ip.ambiguities.map((a) => ({
          ambiguityId: a.ambiguityId,
          location: a.location,
          nonUnique: a.nonUnique,
          kind: a.kind,
          options: a.options.map((o) => ({
            k: o.k,
            legal: o.legal,
            adopted: o.adopted,
            rejectReason: o.rejectReason,
          })),
        })),
      };
    }
  }

  // height
  let heightSteps: HeightPanel | undefined;
  if (chosen) {
    const hView = [...state.entities.values()].find(
      (v) => v.type === 'heightChain' && v.key === chosen.key,
    );
    if (hView) {
      const vv = hView.versions[hView.versions.length - 1];
      const hp = vv.event.payload as HeightChainContent;
      const ras = composedFrame(ledger, hp.heightContentId, rows, cols);
      heightSteps = {
        id: vv.event.eventId,
        steps: hp.steps.map((s) => ({
          index: s.index,
          operation: s.operation,
          formula: s.formula,
          unit: s.outputUnit,
          diagnostic: s.diagnostic,
        })),
        height: asGrid(
          '表面高度（相对标定面）',
          eventGrid(ledger, hView, vv.event.eventId, 'meter', ras, rows, cols, vv.stale),
        ),
      };
    }
  }

  const locks: Array<Record<string, unknown>> = [];
  for (const view of state.entities.values()) {
    if (view.type !== 'regionLock') continue;
    const vv = view.versions[view.versions.length - 1];
    locks.push({ key: view.key, ...(vv.event.payload as object), eventId: vv.event.eventId });
  }

  return {
    projectId,
    headSeq: state.headSeq,
    corruptions: state.corruptions,
    inputs,
    panels,
    ambiguities,
    regions,
    locks,
    history: state.events.map((e) => ({
      seq: e.seq,
      eventId: e.eventId,
      type: e.type,
      at: e.at,
      actor: e.actor,
      entity: e.entity,
      version: e.version,
      refs: e.refs,
    })),
  };
}

function asGrid(
  title: string,
  g: { id: string; unit: string; cells: GridCell[]; rows: number; cols: number; stale: boolean },
): GridPanel {
  return { title, ...g };
}

function findView(
  entities: Map<string, EntityView>,
  type: string,
  key: string,
): EntityView | undefined {
  for (const v of entities.values()) if (v.type === type && v.key === key) return v;
  return undefined;
}
