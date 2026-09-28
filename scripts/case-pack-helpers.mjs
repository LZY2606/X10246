import { createHash } from 'node:crypto';

export const ROWS = 6;
export const COLS = 6;

export function hash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function stableId(prefix, value) {
  return `${prefix}_${hash(value).slice(0, 16)}`;
}

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

export function grid(kind, values) {
  return {
    rows: ROWS,
    cols: COLS,
    values,
    unit: kind === 'mask' ? 'boolean' : kind === 'phase' ? 'radian' : kind === 'amplitude' ? 'adu' : 'score',
    coordinateFrame: 'lab_grid:row_down_col_right_origin_top_left'
  };
}

export function constant(value, mask = Array(ROWS * COLS).fill(false)) {
  return Array.from({ length: ROWS * COLS }, (_, index) => (mask[index] ? null : value));
}

export function ramp(start = -2.6, step = 0.32, mask = Array(ROWS * COLS).fill(false)) {
  return Array.from({ length: ROWS * COLS }, (_, index) => {
    if (mask[index]) return null;
    const value = start + index * step;
    return ((value + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  });
}

export function maskFrom(predicate) {
  const values = [];
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) values.push(predicate(row, col));
  }
  return values;
}

export function holeMask() {
  return maskFrom((row, col) => row >= 2 && row <= 3 && col >= 2 && col <= 3);
}

export function slitMask() {
  return maskFrom((row, col) => col === 3 && row >= 1 && row <= 4);
}

export function wavelength(value = 632.8, unit = 'nanometer') {
  return {
    rawValue: value,
    rawUnit: unit,
    normalizedNanometers: unit === 'nanometer' ? value : unit === 'meter' ? value * 1e9 : null,
    coordinateFrame: 'vacuum_wavelength:instrument_metadata'
  };
}

export function geometry() {
  return {
    incidenceAngle: 0,
    incidenceAngleUnit: 'degree',
    azimuth: 0,
    azimuthUnit: 'degree',
    coordinateFrame: 'lab_optical_axis_z',
    normalizedCosIncidence: 1
  };
}

export function calibration(phaseBias = 0) {
  return {
    model: 'plane_phase_bias',
    phaseBias,
    phaseBiasUnit: 'radian',
    heightBias: 0,
    heightBiasUnit: 'nanometer',
    coordinateFrame: 'calibration_plane:z_zero_at_frame_center'
  };
}

export function cut(editId, rowA, colA, rowB, colB, offset, reason, parentEditId = null) {
  return {
    editId,
    edge: { rowA, colA, rowB, colB },
    explicitOffsetTurns: offset,
    reason,
    editedAt: '2026-09-28T09:00:00+08:00',
    parentEditId
  };
}

export function fragment(role, name, content) {
  const contentId = stableId('frag', [role, name, content]);
  return {
    fragmentId: contentId,
    role,
    name,
    immutable: true,
    contentHash: hash(content),
    content
  };
}
