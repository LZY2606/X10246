import { bitAt, type GridFragment } from "./grid";
import type { ResidueCharge, ResidueMapPayload } from "./types";
import { makeFragment } from "./grid";

export const RESIDUE_ALGO = { algorithmName: "plaquette-winding-residue", algorithmVersion: "1.0.0" } as const;
const TOL = 1e-6;

/**
 * 2x2 小环上沿顺时针 (tl,tr,br,bl) 包裹增量之和：
 *   接近 0 → 无残差；+2pi → +1 电荷；-2pi → -1 电荷。
 */
export function plaquetteCharge(p: [number, number, number, number]): ResidueCharge | null {
  const wrap = (d: number) => {
    let x = d;
    while (x <= -Math.PI) x += 2 * Math.PI;
    while (x > Math.PI) x -= 2 * Math.PI;
    return x;
  };
  const [a, b, c, d] = p;
  const sum = wrap(b - a) + wrap(c - b) + wrap(d - c) + wrap(a - d);
  if (Math.abs(sum) < TOL) return 0;
  if (Math.abs(sum - 2 * Math.PI) < TOL) return 1;
  if (Math.abs(sum + 2 * Math.PI) < TOL) return -1;
  return null;
}

export interface ResidueResult {
  payload: Omit<ResidueMapPayload, "label">;
  fragment: GridFragment;
  residueSites: Array<{ r: number; c: number; charge: ResidueCharge }>;
}

export function computeResidues(phase: GridFragment, valid: GridFragment): ResidueResult {
  const w = phase.width;
  const h = phase.height;
  const cw = w - 1;
  const ch = h - 1;
  const charges: number[] = new Array(cw * ch).fill(0);
  const unknown: Array<{ r: number; c: number }> = [];
  const sites: Array<{ r: number; c: number; charge: ResidueCharge }> = [];
  const at = (r: number, c: number) => (phase.data as number[])[r * w + c] as number;
  for (let r = 0; r < ch; r++) {
    for (let c = 0; c < cw; c++) {
      const quad = [
        [r, c],
        [r, c + 1],
        [r + 1, c + 1],
        [r + 1, c],
      ] as Array<[number, number]>;
      const allValid = quad.every(([rr, cc]) => bitAt(valid, rr, cc) === 1);
      const i = r * cw + c;
      if (!allValid) {
        charges[i] = 0;
        unknown.push({ r, c });
        continue;
      }
      const q = plaquetteCharge([at(r, c), at(r, c + 1), at(r + 1, c + 1), at(r + 1, c)]);
      if (q === null) {
        unknown.push({ r, c });
        charges[i] = 0;
      } else {
        charges[i] = q;
        if (q !== 0) sites.push({ r, c, charge: q });
      }
    }
  }
  const frag = makeFragment("f64", cw, ch, charges);
  return {
    payload: {
      charges: { kind: "gridFragment", fragmentId: frag.fragmentId, encoding: frag.encoding, width: frag.width, height: frag.height, digest: frag.digest },
      unknownPlaquettes: unknown,
      fringeSignConvention: "positive-charge=+2pi-winding",
    },
    fragment: frag,
    residueSites: sites,
  };
}
