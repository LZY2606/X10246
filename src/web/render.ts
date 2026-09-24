/** 网格画布渲染：包裹相位（循环色）、展开相位/高度（线性色）、质量（灰度）、切口叠加。 */
export interface GridLike {
  width: number;
  height: number;
  data: (number | null)[];
}

function cyclicColor(v: number): [number, number, number] {
  const t = (v + Math.PI) / (2 * Math.PI);
  const hue = t * 360;
  return hsl(hue, 0.75, 0.55);
}

function linearColor(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  return hsl(240 - x * 240, 0.8, 0.15 + x * 0.5);
}

function gray(t: number): [number, number, number] {
  const v = Math.round(Math.max(0, Math.min(1, t)) * 255);
  return [v, v, v];
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number] = [0, 0, 0];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = l - c / 2;
  return [Math.round((rgb[0] + m) * 255), Math.round((rgb[1] + m) * 255), Math.round((rgb[2] + m) * 255)];
}

export type ColorMode = 'cyclic' | 'linear' | 'gray';

export function drawGrid(
  canvas: HTMLCanvasElement,
  grid: GridLike,
  mode: ColorMode,
  opts: { scale?: number; unknownCells?: number[] } = {},
): void {
  const scale = opts.scale ?? 18;
  canvas.width = grid.width * scale;
  canvas.height = grid.height * scale;
  const ctx = canvas.getContext('2d')!;
  const unknown = new Set(opts.unknownCells ?? []);
  const vals = grid.data.filter((v): v is number => v !== null);
  const min = vals.length ? Math.min(...vals) : 0;
  const max = vals.length ? Math.max(...vals) : 1;
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const i = y * grid.width + x;
      const v = grid.data[i];
      let rgb: [number, number, number];
      if (v === null || unknown.has(i)) rgb = [40, 40, 46];
      else if (mode === 'cyclic') rgb = cyclicColor(v);
      else if (mode === 'linear') rgb = linearColor(max === min ? 0.5 : (v - min) / (max - min));
      else rgb = gray(v);
      ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
}

export function overlayCuts(
  canvas: HTMLCanvasElement,
  cuts: Array<{ x: number; y: number; dir: 'h' | 'v'; kOffset: number }>,
  cycles: Array<{ x: number; y: number; residue: number }>,
  scale = 18,
): void {
  const ctx = canvas.getContext('2d')!;
  ctx.strokeStyle = '#ff5a4e';
  ctx.lineWidth = 2;
  for (const c of cuts) {
    ctx.beginPath();
    if (c.dir === 'h') {
      ctx.moveTo((c.x + 1) * scale, c.y * scale);
      ctx.lineTo((c.x + 1) * scale, (c.y + 1) * scale);
    } else {
      ctx.moveTo(c.x * scale, (c.y + 1) * scale);
      ctx.lineTo((c.x + 1) * scale, (c.y + 1) * scale);
    }
    ctx.stroke();
    const mx = c.dir === 'h' ? (c.x + 1) * scale : (c.x + 0.5) * scale;
    const my = c.dir === 'h' ? (c.y + 0.5) * scale : (c.y + 1) * scale;
    ctx.fillStyle = '#ffd24e';
    ctx.font = '9px monospace';
    ctx.fillText(`k${c.kOffset >= 0 ? '+' : ''}${c.kOffset}`, mx + 1, my - 1);
  }
  for (const cy of cycles) {
    ctx.fillStyle = cy.residue > 0 ? '#ffe14e' : '#4ec8ff';
    ctx.beginPath();
    ctx.arc((cy.x + 1) * scale, (cy.y + 1) * scale, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}
