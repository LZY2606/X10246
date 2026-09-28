import { convertQuantity, pixelToPhysical } from './units.js';
import type { Diagnostic, Quantity } from './units.js';
import type { CalibrationPlaneContent, HeightResultData, IlluminationGeometryContent, WavelengthContent } from './events.js';

/**
 * 干涉高度转换链：
 *   s = λ / (cosθi + cosθo)
 *   h_raw = (φ + 2πk) / (2π) · s
 *   h     = h_raw − (a·x + b·y + c)
 * 单位无法转换时高度保持 null 并附诊断，不为了画图丢值。
 */
export function computeHeight(
  width: number, height: number,
  unwrapped: (number | null)[],
  wavelength: WavelengthContent,
  geometry: IlluminationGeometryContent,
  calibration: CalibrationPlaneContent | null
): HeightResultData {
  const diagnostics: Diagnostic[] = [];
  const chain: HeightResultData['chain'] = [];

  const lambda = convertQuantity(wavelength.lambda, 'nm');
  if (!lambda.ok) diagnostics.push(lambda.diagnostic);
  const ti = convertQuantity(geometry.thetaI, 'rad');
  if (!ti.ok) diagnostics.push(ti.diagnostic);
  const to = convertQuantity(geometry.thetaO, 'rad');
  if (!to.ok) diagnostics.push(to.diagnostic);

  let sensitivity: Quantity | null = null;
  if (lambda.ok && ti.ok && to.ok) {
    const denom = Math.cos(ti.value) + Math.cos(to.value);
    sensitivity = { value: lambda.value / denom, unit: 'nm' };
    chain.push({
      step: 'sensitivity',
      detail: `s = λ/(cosθi+cosθo) = ${lambda.value.toFixed(4)}/(${Math.cos(ti.value).toFixed(4)}+${Math.cos(to.value).toFixed(4)}) = ${sensitivity.value.toFixed(4)} nm/周`
    });
  } else {
    chain.push({ step: 'sensitivity', detail: '单位无法转换，敏感度未知；高度保留 null' });
  }

  const canCompute = sensitivity !== null;
  const rawGrid = new Array<number | null>(width * height).fill(null);
  if (canCompute) {
    for (let i = 0; i < width * height; i++) {
      if (unwrapped[i] === null) continue;
      rawGrid[i] = (unwrapped[i] as number) / (2 * Math.PI) * sensitivity.value;
    }
    chain.push({ step: 'raw-height', detail: `h_raw = (φ+2πk)/2π · s，共 ${rawGrid.filter(v => v !== null).length} 个像素，单位 nm` });
  }

  let frame: HeightResultData['frame'] = 'sensor-pixel';
  const heightGrid = new Array<number | null>(width * height).fill(null);
  if (calibration && canCompute) {
    const aQ = convertQuantity(calibration.a, 'nm/px');
    const bQ = convertQuantity(calibration.b, 'nm/px');
    const cQ = convertQuantity(calibration.c, 'nm');
    if (!aQ.ok) diagnostics.push(aQ.diagnostic);
    if (!bQ.ok) diagnostics.push(bQ.diagnostic);
    if (!cQ.ok) diagnostics.push(cQ.diagnostic);
    if (aQ.ok && bQ.ok && cQ.ok) {
      frame = calibration.frame;
      for (let r = 0; r < height; r++) {
        for (let c = 0; c < width; c++) {
          const i = r * width + c;
          if (rawGrid[i] === null) continue;
          heightGrid[i] = rawGrid[i]! - (aQ.value * c + bQ.value * r + cQ.value);
        }
      }
      chain.push({ step: 'calibrate-plane', detail: `h = h_raw − (a·col+b·row+c)，基准 ${calibration.frame}` });
      if (calibration.frame === 'sample-physical' && !geometry.pixelPitch) {
        diagnostics.push({
          code: 'FRAME_UNCONVERTIBLE',
          message: '标定面声明 sample-physical 但未提供 pixelPitch；系数按像素坐标应用并保留原声明'
        });
      }
    } else {
      rawGrid.forEach((v, i) => { heightGrid[i] = v; });
      chain.push({ step: 'calibrate-plane', detail: '标定系数单位无法转换，返回未标定 h_raw 并附诊断' });
    }
  } else if (canCompute) {
    rawGrid.forEach((v, i) => { heightGrid[i] = v; });
    chain.push({ step: 'calibrate-plane', detail: '无标定面，高度 = h_raw（sensor-pixel）' });
  }
  void pixelToPhysical;

  return { heightGrid, unit: 'nm', frame, chain, diagnostics };
}
