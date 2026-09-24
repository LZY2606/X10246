import type { ComponentPayload, Grid } from '../shared/domain';
import { idx } from './grid';

/** 4-邻接连通区标号：mask=1 与包裹相位非有限值均为无效 */
export function labelComponents(wrapped: Grid, mask: Grid): ComponentPayload {
  const { width, height } = wrapped;
  const labels = new Array(width * height).fill(0);
  const sizes: number[] = [0];
  let next = 1;
  const valid = (i: number) => mask.values[i] !== 1 && Number.isFinite(wrapped.values[i]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = idx(wrapped, x, y);
      if (!valid(s) || labels[s] !== 0) continue;
      const id = next++;
      let size = 0;
      const stack = [s];
      labels[s] = id;
      while (stack.length) {
        const p = stack.pop()!;
        size++;
        const px = p % width, py = (p / width) | 0;
        const neigh = [[px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]];
        for (const [nx, ny] of neigh) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = idx(wrapped, nx, ny);
          if (valid(ni) && labels[ni] === 0) { labels[ni] = id; stack.push(ni); }
        }
      }
      sizes.push(size);
    }
  }
  return {
    grid: { width, height, unit: '1', coordFrame: 'detector-pixel', values: labels },
    componentCount: next - 1,
    componentSizes: sizes.slice(1),
  };
}
