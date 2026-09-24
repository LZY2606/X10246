export type EntityKind =
  | 'WrappedPhaseField'
  | 'QualityMap'
  | 'InvalidMask'
  | 'WavelengthSpec'
  | 'IncidenceGeometry'
  | 'CalibrationSurface'
  | 'CutEditHistory';

export const INPUT_KINDS: EntityKind[] = [
  'WrappedPhaseField',
  'QualityMap',
  'InvalidMask',
  'WavelengthSpec',
  'IncidenceGeometry',
  'CalibrationSurface',
  'CutEditHistory',
];

export type ResultKind =
  | 'ResidueMap'
  | 'CutNetwork'
  | 'UnwrapCandidate'
  | 'HeightField';

export interface Ref {
  id: string;
  version: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rectsIntersect(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return true;
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export interface GridBasis {
  pixelSizeUm: number;
  originUm: [number, number];
}

export interface WrappedPhaseFieldContent {
  width: number;
  height: number;
  unit: 'rad';
  basis: GridBasis;
  values: number[];
  raw: string;
}

export interface QualityMapContent {
  width: number;
  height: number;
  metric: 'snr-db' | 'modulation';
  threshold: number;
  values: number[];
  raw: string;
}

export interface InvalidMaskContent {
  width: number;
  height: number;
  values: number[];
  raw: string;
}

export interface WavelengthSpecContent {
  valueNm: number;
  source: string;
  raw: string;
}

export interface IncidenceGeometryContent {
  thetaDeg: number;
  phiDeg: number;
  reflection: boolean;
  raw: string;
}

export interface CalibrationSurfaceContent {
  model: 'plane';
  coeffsNm: [number, number, number];
  basis: GridBasis;
  raw: string;
}

export interface CutEdit {
  op: 'add' | 'remove';
  edge: { x: number; y: number; dir: 'h' | 'v' };
  author: string;
  note: string;
}

export interface CutEditHistoryContent {
  edits: CutEdit[];
}
