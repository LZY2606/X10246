export interface GridSpec {
  cols: number;
  rows: number;
  pixelPitchX: number;
  pixelPitchY: number;
  pitchUnit: "um" | "mm" | "m";
  origin: string;
}

export class Grid {
  constructor(readonly spec: GridSpec) {}
  get cols() {
    return this.spec.cols;
  }
  get rows() {
    return this.spec.rows;
  }
  index(col: number, row: number): number {
    return row * this.spec.cols + col;
  }
  coord(index: number): { col: number; row: number } {
    return { col: index % this.spec.cols, row: Math.floor(index / this.spec.cols) };
  }
  inBounds(col: number, row: number): boolean {
    return col >= 0 && row >= 0 && col < this.spec.cols && row < this.spec.rows;
  }
  get size() {
    return this.spec.cols * this.spec.rows;
  }
  neighbors(index: number): Array<{ index: number; dir: "E" | "S" | "W" | "N" }> {
    const { col, row } = this.coord(index);
    const out: Array<{ index: number; dir: "E" | "S" | "W" | "N" }> = [];
    if (col + 1 < this.cols) out.push({ index: this.index(col + 1, row), dir: "E" });
    if (row + 1 < this.rows) out.push({ index: this.index(col, row + 1), dir: "S" });
    if (col - 1 >= 0) out.push({ index: this.index(col - 1, row), dir: "W" });
    if (row - 1 >= 0) out.push({ index: this.index(col, row - 1), dir: "N" });
    return out;
  }
}
