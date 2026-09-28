import { mkdirSync, writeFileSync } from 'node:fs';
import {
  COLS,
  ROWS,
  calibration,
  constant,
  cut,
  fragment,
  geometry,
  grid,
  hash,
  holeMask,
  maskFrom,
  ramp,
  slitMask,
  stableId,
  wavelength
} from './case-pack-helpers.mjs';

const noMask = Array(ROWS * COLS).fill(false);
const highAmplitude = constant(1200, noMask);
const highQuality = constant(0.96, noMask);
const lowHole = constant(1200, noMask).map((value, index) => (holeMask()[index] ? 18 : value));
const qualityHole = constant(0.96, noMask).map((value, index) => (holeMask()[index] ? 0.08 : value));
const twoComponentsMask = maskFrom((row, col) => col === 3 && row >= 1 && row <= 4);

const fragments = [
  fragment('wrapped_phase_pixels', 'smooth_wrapped_ramp_with_branch', grid('phase', ramp(-2.8, 0.34))),
  fragment('amplitude_map', 'uniform_high_amplitude', grid('amplitude', highAmplitude)),
  fragment('signal_quality_scores', 'uniform_high_quality', grid('quality', highQuality)),
  fragment('invalid_mask', 'all_pixels_valid', grid('mask', noMask)),
  fragment('wavelength', 'helium_neon_632_8_nm_v1', wavelength(632.8)),
  fragment('illumination_geometry', 'normal_incidence_v1', geometry()),
  fragment('calibration_surface', 'zero_plane_phase_bias_v1', calibration(0)),
  fragment('cut_edit_history', 'no_edits_v1', { coordinateFrame: 'lab_grid:row_down_col_right_origin_top_left', edits: [] }),
  fragment('amplitude_map', 'low_amplitude_square_hole', grid('amplitude', lowHole)),
  fragment('signal_quality_scores', 'low_quality_square_hole', grid('quality', qualityHole)),
  fragment('invalid_mask', 'square_hole_invalid', grid('mask', holeMask())),
  fragment('invalid_mask', 'vertical_slit_creates_two_components', grid('mask', slitMask())),
  fragment('cut_edit_history', 'wrong_branch_cut_offset_minus_one', {
    coordinateFrame: 'lab_grid:row_down_col_right_origin_top_left',
    edits: [cut('cut_0001', 1, 0, 1, 1, -1, 'OPEN_CYCLE_DIAGNOSTIC_SURFACE_JUMP')]
  }),
  fragment('wavelength', 'revised_633_0_nm_v2', wavelength(633.0)),
  fragment('cut_edit_history', 'two_legal_integer_offsets', {
    coordinateFrame: 'lab_grid:row_down_col_right_origin_top_left',
    edits: [cut('cut_0101', 3, 1, 3, 2, null, 'INTEGER_AMBIGUITY_REQUIRES_CANDIDATES')]
  }),
  fragment('cut_edit_history', 'conflicting_local_locks_seed', {
    coordinateFrame: 'lab_grid:row_down_col_right_origin_top_left',
    edits: [cut('cut_0201', 2, 1, 2, 2, null, 'LOCAL_LOCK_CONFLICT_TARGET')]
  })
];

const byName = Object.fromEntries(fragments.map((item) => [item.name, item]));

function refs(names) {
  return names.map((name) => byName[name].fragmentId);
}

function bindings(phase, amplitude, quality, mask, wave, geo, cal, cuts) {
  return {
    wrapped_phase_pixels: refs([phase]),
    amplitude_map: refs([amplitude]),
    signal_quality_scores: refs([quality]),
    invalid_mask: refs([mask]),
    wavelength: refs([wave]),
    illumination_geometry: refs([geo]),
    calibration_surface: refs([cal]),
    cut_edit_history: refs([cuts])
  };
}

const common = bindings(
  'smooth_wrapped_ramp_with_branch',
  'uniform_high_amplitude',
  'uniform_high_quality',
  'all_pixels_valid',
  'helium_neon_632_8_nm_v1',
  'normal_incidence_v1',
  'zero_plane_phase_bias_v1',
  'no_edits_v1'
);

const scenarios = [
  ['phase_branch_boundary', '相位跨越边界', 'no_edits_v1', 'all_pixels_valid', 'helium_neon_632_8_nm_v1'],
  ['low_amplitude_hole', '低振幅孔洞', 'no_edits_v1', 'all_pixels_valid', 'helium_neon_632_8_nm_v1'],
  ['multiply_connected_region', '多连通区', 'no_edits_v1', 'vertical_slit_creates_two_components', 'helium_neon_632_8_nm_v1'],
  ['open_cycle', '循环不闭合', 'wrong_branch_cut_offset_minus_one', 'all_pixels_valid', 'helium_neon_632_8_nm_v1'],
  ['wavelength_version_change', '波长版本变更', 'no_edits_v1', 'all_pixels_valid', 'revised_633_0_nm_v2'],
  ['integer_ambiguity', '整周多解', 'two_legal_integer_offsets', 'all_pixels_valid', 'helium_neon_632_8_nm_v1'],
  ['local_lock_conflict', '局部锁定冲突', 'conflicting_local_locks_seed', 'all_pixels_valid', 'helium_neon_632_8_nm_v1']
];

const scenarioInputs = scenarios.map(([code, title, cuts, maskName, waveName], index) => {
  const useHole = code === 'low_amplitude_hole';
  const combinedMask = code === 'low_amplitude_hole' ? 'square_hole_invalid' : maskName;
  return {
    code,
    title,
    minimalInput: {
      inputId: stableId('minput', [code]),
      scenarioId: code,
      interpretationVersion: `fringe-ledger-domain-v1.${index + 1}`,
      fragmentBindings: bindings(
        'smooth_wrapped_ramp_with_branch',
        useHole ? 'low_amplitude_square_hole' : 'uniform_high_amplitude',
        useHole ? 'low_quality_square_hole' : 'uniform_high_quality',
        useHole ? 'all_pixels_valid' : maskName,
        waveName,
        'normal_incidence_v1',
        'zero_plane_phase_bias_v1',
        cuts
      )
    },
    combinedInput: {
      inputId: stableId('cinput', [code]),
      scenarioId: code,
      interpretationVersion: `fringe-ledger-domain-v2.${index + 1}`,
      fragmentBindings: bindings(
        'smooth_wrapped_ramp_with_branch',
        code === 'multiply_connected_region' ? 'uniform_high_amplitude' : 'low_amplitude_square_hole',
        code === 'multiply_connected_region' ? 'uniform_high_quality' : 'low_quality_square_hole',
        combinedMask,
        waveName,
        'normal_incidence_v1',
        'zero_plane_phase_bias_v1',
        cuts
      )
    }
  };
});

const casePack = {
  schema: 'fringe-ledger/offline-case-pack/v1',
  title: '干涉条纹簿：相位展开、支路切口与光学标定分支',
  generatedAt: '2026-09-28T09:00:00+08:00',
  seed: 'fringe-ledger-fixed-seed-2026-09-28',
  unitsPolicy: '原始单位与坐标基准保留在原片段；派生层才规范化，不能转换的数值留空并带诊断。',
  gridGeometry: { rows: ROWS, cols: COLS },
  immutableBaseline: ['原相位像素', '信噪评分', '无效遮罩', '波长', '入射几何', '标定面', '切口编辑历史'],
  fragments,
  scenarios: scenarioInputs,
  replay: [
    { sequence: 1, event: 'BASELINE_IMPORTED', description: '导入七类不可覆盖原始实体。' },
    { sequence: 2, event: 'PARAMETER_REVISED', description: '把振幅/质量阈值从宽阈值修订到实验阈值。' },
    { sequence: 3, event: 'LOCAL_SOURCE_CHANGED', description: '仅新增低振幅孔洞片段，只让直接依赖运行过期。' },
    { sequence: 4, event: 'CONFLICTING_HUMAN_DECISION', description: '对同一支路记录两个不同整周锁定。' },
    { sequence: 5, event: 'FINAL_REVIEW_EXPORT_REIMPORT', description: '并排复核后导出、删除本地数据库并重新导入。' }
  ],
  checksum: ''
};
casePack.checksum = hash(casePack);
mkdirSync('case-pack', { recursive: true });
writeFileSync('case-pack/fringe-ledger.case-pack.json', JSON.stringify(casePack, null, 2));
console.log(`wrote ${fragments.length} immutable fragments and ${scenarios.length} scenario pairs`);
