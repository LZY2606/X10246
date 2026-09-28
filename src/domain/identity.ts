import { createHash } from 'node:crypto';
import type { SourceMaterial, SourceVersion, VersionRef } from './types.js';

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

export function shortId(prefix: string, value: unknown): string {
  return `${prefix}_${digest(value).slice(7, 18)}`;
}

export function materialVersionId(input: {
  materialId: string;
  versionNumber: number;
  material: SourceMaterial;
}): { versionId: string; contentDigest: string } {
  const contentDigest = digest(input.material);
  return {
    versionId: `${input.materialId}@v${input.versionNumber}:${contentDigest.slice(7, 16)}`,
    contentDigest,
  };
}

export function versionRef(version: SourceVersion): VersionRef {
  return {
    kind: version.kind,
    materialId: version.materialId,
    versionId: version.versionId,
    versionNumber: version.versionNumber,
    contentDigest: version.contentDigest,
  };
}

export function sameRef(a: VersionRef, b: VersionRef): boolean {
  return (
    a.kind === b.kind &&
    a.materialId === b.materialId &&
    a.versionId === b.versionId &&
    a.versionNumber === b.versionNumber &&
    a.contentDigest === b.contentDigest
  );
}
