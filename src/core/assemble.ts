import type {
  AssembledInputs,
  Fragment,
  InputKind,
  InputVersion,
  MaskDatum,
  PixelDatum
} from './types.ts';
import type { CaseProjectSpec } from './casepack.ts';

type TileCell = {
  x: number;
  y: number;
  wrapped_phase: number;
  amplitude: number;
  signal_noise: number;
  invalid_mask: boolean;
  invalid_reason: 'valid' | 'mask_imported' | 'outside_calibration';
};

function pixel(id: string, x: number, y: number, value: number, unit: PixelDatum['unit'], source: string): PixelDatum {
  return { x, y, value, unit, originalRepresentation: `${source}@(${x},${y})=${value}` };
}

export function assembleProject(
  spec: Pick<CaseProjectSpec, 'id' | 'width' | 'height'>,
  fragments: Fragment[],
  versions: Record<InputKind, InputVersion>,
  wavelengthFragmentId: string
): AssembledInputs {
  const fragmentById = new Map(fragments.map((fragment) => [fragment.id, fragment]));
  const layerVersions: InputKind[] = ['wrapped_phase', 'amplitude', 'signal_noise', 'invalid_mask'];
  const tileVersions = versions.wrapped_phase;
  const tileIds = new Set(tileVersions.fragmentIds);
  const cells = new Map<string, TileCell>();
  for (const fragmentId of tileIds) {
    const fragment = fragmentById.get(fragmentId);
    if (!fragment) throw new Error(`corrupt:missing_fragment:${fragmentId}`);
    const rows = fragment.data as TileCell[][];
    for (const row of rows) for (const cell of row) cells.set(`${cell.x}:${cell.y}`, cell);
  }
  const phase: PixelDatum[] = [];
  const amplitude: PixelDatum[] = [];
  const signalNoise: PixelDatum[] = [];
  const mask: MaskDatum[] = [];
  for (let y = 0; y < spec.height; y += 1) {
    for (let x = 0; x < spec.width; x += 1) {
      const cell = cells.get(`${x}:${y}`);
      if (!cell) throw new Error(`corrupt:missing_pixel:${x}:${y}`);
      phase.push(pixel(`phase_${x}_${y}`, x, y, cell.wrapped_phase, 'radian', 'imported_wrapped_phase[rad]'));
      amplitude.push(pixel(`amplitude_${x}_${y}`, x, y, cell.amplitude, 'dimensionless', 'imported_amplitude[normalized]'));
      signalNoise.push(pixel(`snr_${x}_${y}`, x, y, cell.signal_noise, 'decibel', 'imported_signal_noise[dB]'));
      mask.push({
        x,
        y,
        invalid: cell.invalid_mask,
        reason: cell.invalid_mask ? (cell.invalid_reason === 'outside_calibration' ? 'outside_calibration' : 'mask_imported') : 'valid',
        originalRepresentation: `imported_invalid_mask[bool]@(${x},${y})=${cell.invalid_mask}`
      });
    }
  }
  const scalar = <T>(kind: InputKind): T => {
    const id = versions[kind].fragmentIds[0];
    const fragment = fragmentById.get(id ?? '');
    if (!fragment) throw new Error(`corrupt:missing_fragment:${String(id)}`);
    return fragment.data as T;
  };
  const wavelength = scalar<AssembledInputs['wavelength']>('wavelength');
  if (wavelengthFragmentId && !versions.wavelength.fragmentIds.includes(wavelengthFragmentId)) {
    throw new Error(`corrupt:wavelength_reference_mismatch:${wavelengthFragmentId}`);
  }
  return {
    width: spec.width,
    height: spec.height,
    phase,
    amplitude,
    signalNoise,
    mask,
    wavelength,
    geometry: scalar<AssembledInputs['geometry']>('incidence_geometry'),
    calibration: scalar<AssembledInputs['calibration']>('calibration_plane'),
    cutHistory: scalar<AssembledInputs['cutHistory']>('cut_edit_history'),
    versions
  };
}
