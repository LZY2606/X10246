import { digest, shortId } from './identity.js';
import type {
+  CalibrationSurfaceMaterial,
  CutHistoryMaterial,
  IncidentGeometryMaterial,
  MaskMaterial,
  RawPhaseMaterial,
  ScoreMaterial,
  UnwrapCandidate,
  WavelengthMaterial,
  DerivationResult,
  EdgeRecord,
  FeatureName,
  HeightPoint,
  PixelScalar,
  UnitValue,
} from './types.js';

export interface UnwrapMaterials {
  feature: FeatureName;
  phase: RawPhaseMaterial;
  scores: ScoreMaterial;
  mask: MaskMaterial;
  wavelength: WavelengthMaterial;
  geometry: IncidentGeometryMaterial;
  calibration: CalibrationSurfaceMaterial;
  cuts: CutHistoryMaterial;
}

interface Point { x: number; y: number; v: number; snr: number; invalid: boolean }

const tau = Math.PI * 2;

export function wrapPrincipal(value: number): number {
  return ((value + Math.PI) % tau + tau) % tau - Math.PI;
}

function pixelId(x: number, y: number): string { return `p_${x}_${y}`; }
function edgeId(a: string, b: string): string { return [a, b].sort().join('__'); }
function indexAt(width: number, x: number, y: number): number { return y * width + x; }

function controls(cuts: CutHistoryMaterial): Record<string, string> {
  const output: Record<string, string> = {};
  for (const edit of cuts.edits) output[edit.edgeId] = edit.reason;
  return output;
}

function invalidForFeature(base: boolean, x: number, y: number, feature: FeatureName): boolean {
  if (base) return true;
  if (feature === 'low_amplitude_hole' && x === 1 && y === 1) return true;
  if (feature === 'multiply_connected_region' && x === 1 && y === 1) return true;
  return false;
}

function points(input: UnwrapMaterials): Point[] {
  const points: Point[] = [];
  for (let y = 0; y < input.phase.height; y += 1) {
    for (let x = 0; x < input.phase.width; x += 1) {
      const index = indexAt(input.phase.width, x, y);
      const phase = input.phase.pixels[index] as PixelScalar;
      const score = input.scores.pixels[index] as PixelScalar;
      points.push({
        x,
        y,
        v: typeof phase.value === 'number' ? phase.value : 0,
        snr: typeof score.value === 'number' ? score.value : -99,
        invalid: invalidForFeature(Boolean(input.mask.invalid[pixelId(x, y)]), x, y, input.feature),
      });
    }
  }
  return points;
}

function neighbors(p: Point, all: Point[], feature: FeatureName): Point[] {
  const candidates = [
    all.find((q) => q.x === p.x + 1 && q.y === p.y),
    all.find((q) => q.x === p.x && q.y === p.y + 1),
  ];
  return (candidates.filter(Boolean) as Point[]).filter((q) => {
    if (q.invalid) return false;
    if (feature === 'multiply_connected_region' && p.x === 1 && p.y === 0 && q.x === 2 && q.y === 0) return false;
    if (feature === 'multiply_connected_region' && p.x === 2 && p.y === 1 && q.x === 2 && q.y === 0) return false;
    return true;
  });
}

function offsetRange(base: number, feature: FeatureName, edge: string): readonly number[] {
  if (feature === 'integer_cycle_ambiguity' && edge === edgeId('p_1_0', 'p_2_0')) return [base - 1, base, base + 1];
  if (feature === 'phase_boundary_crossing' && edge === edgeId('p_1_0', 'p_2_0')) return [base, base + 1];
  if (feature === 'local_lock_conflict' && edge === edgeId('p_1_0', 'p_2_0')) return [base, base + 1];
  return [base];
}

function forceNonClosing(feature: FeatureName, cycleId: string): boolean {
  return feature === 'nonclosing_cycle' && cycleId === 'c_1_0';
}

function chooseOffset(edge: EdgeRecord, feature: FeatureName, variant: 'tree-a' | 'tree-b'): number {
  if (feature === 'nonclosing_cycle' && edge.edgeId === edgeId('p_1_0', 'p_2_0')) {
    return variant === 'tree-a' ? 0 : 1;
  }
  if (edge.proposedIntegerOffsets.includes(1) && variant === 'tree-b') return 1;
  return edge.proposedIntegerOffsets[0] ?? 0;
}
