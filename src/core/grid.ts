import { createHash } from "node:crypto";
import type { GridFragment, GridFragmentRef, GridEncoding } from "./types";

export function idx(width: number, r: number, c: number): number {
  return r * width + c;
}

export function inBounds(width: number, height: number, r: number, c: number): boolean {
  return r >= 0 && c >= 0 && r < height && c < width;
}

export function numAt(g: GridFragment, r: number, c: number): number {
  const v = (g.data as number[])[idx(g.width, r, c)];
  if (v === undefined) throw new Error(`grid 越界 r=${r} c=${c}`);
  return v;
}

export function bitAt(g: GridFragment, r: number, c: number): 0 | 1 {
  const ch = (g.data as string).charAt(idx(g.width, r, c));
  return ch === "1" ? 1 : 0;
}

export function digestFragment(encoding: GridEncoding, width: number, height: number, data: number[] | string): string {
  const h = createHash("sha256");
  h.update(encoding);
  h.update("|");
  h.update(`${width}x${height}`);
  h.update("|");
  if (typeof data === "string") h.update(data);
  else h.update(new Float64Array(data).buffer);
  return h.digest("hex");
}

export function makeFragment(encoding: GridEncoding, width: number, height: number, data: number[] | string): GridFragment {
  if (encoding === "bits" && typeof data === "string") {
    if (data.length !== width * height) throw new Error("bits 片段长度不符");
  } else if (Array.isArray(data)) {
    if (data.length !== width * height) throw new Error("数值片段长度不符");
  } else {
    throw new Error("片段编码/数据不匹配");
  }
  const digest = digestFragment(encoding, width, height, data);
  return { kind: "gridFragment", fragmentId: `frag_${digest.slice(0, 24)}`, encoding, width, height, digest, data };
}

export function refOf(f: GridFragment): GridFragmentRef {
  return { kind: "gridFragment", fragmentId: f.fragmentId, encoding: f.encoding, width: f.width, height: f.height, digest: f.digest };
}

export function f64(width: number, height: number, fill: (r: number, c: number) => number): GridFragment {
  const data: number[] = new Array(width * height);
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) data[idx(width, r, c)] = fill(r, c);
  return makeFragment("f64", width, height, data);
}

export function bits(width: number, height: number, fill: (r: number, c: number) => 0 | 1): GridFragment {
  let data = "";
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) data += fill(r, c) === 1 ? "1" : "0";
  return makeFragment("bits", width, height, data);
}

/** 包裹到主值 (-pi, pi]。 */
export function wrapToPi(x: number): number {
  let y = x % (2 * Math.PI);
  if (y <= -Math.PI) y += 2 * Math.PI;
  if (y > Math.PI) y -= 2 * Math.PI;
  return y;
}

/** 包裹增量的等价最小增量，范围 (-pi, pi]。 */
export function wrappedDelta(a: number, b: number): number {
  return wrapToPi(b - a);
}
