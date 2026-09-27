import { createHash } from 'node:crypto';

export function sha256Json(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
}

export function stableProjectId(seed: string): string {
  return `prj_${createHash('sha256').update(`project:${seed}`).digest('hex').slice(0, 20)}`;
}

let counter = 0;

export function deterministicId(prefix: string, logicalTime: string, seed: string, name: string): string {
  counter += 1;
  return `${prefix}_${createHash('sha256')
    .update(`${logicalTime}|${seed}|${name}|${counter}`)
    .digest('hex')
    .slice(0, 20)}`;
}

export function resetDeterministicCounter(): void {
  counter = 0;
}

export function pixelKey(pixel: [number, number]): string {
  return `${pixel[0]},${pixel[1]}`;
}

export function edgeKey(from: [number, number], to: [number, number]): string {
  const left = pixelKey(from);
  const right = pixelKey(to);
  return [left, right].sort().join('~');
}
