import { Store } from './store';
import { UNWRAP_ALGORITHM_VERSION, paramFingerprint, unwrapField, type UnwrapParams } from './engine/unwrap';
import { HEIGHT_ALGORITHM_VERSION, heightFromPhase } from './engine/height';
import type {
  CalibrationPlane, CutSegment, GridField, IncidenceGeometry, MaskGrid,
  SourceRef, WavelengthValue,
} from '../shared/domain';

export const DEFAULT_PARAMS: UnwrapParams = { lowAmplitudeThreshold: 0.2, seed: 42 };

function srcOf(v: { id: string; kind: string; versionNo: number; contentHash: string }): SourceRef {
  return { id: v.id, kind: v.kind as SourceRef['kind'], versionNo: v.versionNo, contentHash: v.contentHash };
}

export interface DerivationResult {
  candidateIds: string[];
  qualityMapId: string;
  offsetSetId: string | null;
  cycleSetId: string;
  ambiguityGroupId: string | null;
  eventIds: string[];
}

// 完整派生链：原相位/信噪/遮罩/切口 → 质量图、展开候选、整周偏移、循环残差、多解组
export function runUnwrapDerivation(store: Store, params: UnwrapParams = DEFAULT_PARAMS): DerivationResult {
  const wrapped = store.latestInput('wrapped_phase');
  const quality = store.latestInput('quality_score');
  const mask = store.latestInput('invalid_mask');
  const cuts = store.latestInput('cut_edit_history');
  if (!wrapped || !quality || !mask) {
    const evt = store.recordEvent('DERIVATION_FAILED', [], {
      rule: 'missing-required-inputs',
      missing: [
        !wrapped ? 'wrapped_phase' : null,
        !quality ? 'quality_score' : null,
        !mask ? 'invalid_mask' : null,
      ].filter(Boolean),
    });
    return { candidateIds: [], qualityMapId: '', offsetSetId: null, cycleSetId: '', ambiguityGroupId: null, eventIds: [evt.id] };
  }
  const cutList = cuts ? (cuts.content as { segments: CutSegment[] }).segments ?? [] : [];
  const fingerprint = paramFingerprint(UNWRAP_ALGORITHM_VERSION, params as unknown as Record<string, unknown>);
  const output = unwrapField(
    wrapped.content as GridField,
    quality.content as GridField,
    mask.content as MaskGrid,
    cutList,
    params,
  );
  const baseSources = [wrapped, quality, mask, ...(cuts ? [cuts] : [])].map(srcOf);

  const qualityMap = store.saveDerived(
    'quality_map', UNWRAP_ALGORITHM_VERSION, fingerprint, baseSources,
    { width: (wrapped.content as GridField).width, height: (wrapped.content as GridField).height, unit: 'normalized', frame: (wrapped.content as GridField).frame, data: output.qualityMap },
    null,
  );

  const candidateIds: string[] = [];
  for (const cand of output.candidates) {
    const saved = store.saveDerived(
      'unwrap_candidate', UNWRAP_ALGORITHM_VERSION, fingerprint, baseSources,
      {
        candidateId: cand.candidateId, component: cand.component, tree: cand.tree,
        kShift: cand.kShift, shiftEdge: cand.shiftEdge, path: cand.path,
        unwrapped: cand.unwrapped, cycleResiduals: cand.cycleResiduals,
        unit: 'rad', frame: (wrapped.content as GridField).frame,
      },
      cand.pixels,
    );
    candidateIds.push(saved.id);
  }

  let offsetSetId: string | null = null;
  if (output.integerOffsets.length) {
    offsetSetId = store.saveDerived(
      'integer_offset_set', UNWRAP_ALGORITHM_VERSION, fingerprint, baseSources,
      { offsets: output.integerOffsets, unit: 'turns', frame: (wrapped.content as GridField).frame },
      null,
    ).id;
  }

  const cycleSetId = store.saveDerived(
    'cycle_residual_set', UNWRAP_ALGORITHM_VERSION, fingerprint, baseSources,
    { cycles: output.cycles, unit: 'rad', frame: (wrapped.content as GridField).frame },
    null,
  ).id;

  let ambiguityGroupId: string | null = null;
  if (output.candidates.length > output.componentCount) {
    ambiguityGroupId = store.saveDerived(
      'ambiguity_group', UNWRAP_ALGORITHM_VERSION, fingerprint, baseSources,
      {
        rule: 'keep-all-legal-integer-candidates',
        candidateIds,
        components: output.componentCount,
      },
      null,
    ).id;
  }

  const eventIds: string[] = [];
  for (const evt of output.events) {
    const rec = store.recordEvent(evt.type as never, candidateIds, evt.basis);
    eventIds.push(rec.id);
  }
  return { candidateIds, qualityMapId: qualityMap.id, offsetSetId, cycleSetId, ambiguityGroupId, eventIds };
}

// 高度转换链：展开候选 × 波长 × 入射几何 × 标定面 → 表面高度（nm）
export function runHeightDerivation(store: Store, candidateDerivedId: string) {
  const candidate = store.getDerived(candidateDerivedId);
  if (!candidate) throw new Error(`CANDIDATE_NOT_FOUND:${candidateDerivedId}`);
  const wavelength = store.latestInput('wavelength');
  const geometry = store.latestInput('incidence_geometry');
  const calibration = store.latestInput('calibration_plane');
  if (!wavelength || !geometry || !calibration) {
    const evt = store.recordEvent('DERIVATION_FAILED', [candidateDerivedId], {
      rule: 'height-chain-requires-wavelength-geometry-calibration',
      missing: [
        !wavelength ? 'wavelength' : null,
        !geometry ? 'incidence_geometry' : null,
        !calibration ? 'calibration_plane' : null,
      ].filter(Boolean),
    });
    return { heightMapId: null, eventIds: [evt.id] };
  }
  const candContent = candidate.content as { unwrapped: (number | null)[] };
  const wrapped = store.latestInput('wrapped_phase')!;
  const wf = wrapped.content as GridField;
  const height = heightFromPhase(
    candContent.unwrapped, wf.width, wf.height,
    calibration.content as CalibrationPlane,
    wavelength.content as WavelengthValue,
    geometry.content as IncidenceGeometry,
  );
  const fingerprint = paramFingerprint(HEIGHT_ALGORITHM_VERSION, {});
  const saved = store.saveDerived(
    'height_map', HEIGHT_ALGORITHM_VERSION, fingerprint,
    [
      { id: candidate.id, kind: candidate.kind, versionNo: candidate.createdSeq, contentHash: candidate.contentHash },
      srcOf(wavelength), srcOf(geometry), srcOf(calibration),
    ],
    height,
    candidate.pixels,
  );
  return { heightMapId: saved.id, eventIds: [] };
}
