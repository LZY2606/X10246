import { createHash } from 'node:crypto';

/** 稳定排序的 JSON 序列化：同一内容永远得到同一字符串。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function contentHash(content: unknown): string {
  return sha256(canonicalJson(content));
}

export function shortHash(content: unknown, len = 16): string {
  return contentHash(content).slice(0, len);
}

/** 内容寻址：相同内容只存一份。 */
export function blobId(content: unknown): string {
  return `blob_${contentHash(content)}`;
}

export function entityIdFor(projectId: string, kind: string, label: string): string {
  return `ent_${shortHash({ projectId, kind, label })}`;
}

export function versionIdFor(blobHash: string): string {
  return `ver_${sha256(blobHash).slice(0, 16)}`;
}

export function eventIdFor(projectId: string, seq: number): string {
  return `evt_${shortHash({ projectId, seq })}`;
}

export function candidateIdFor(parts: unknown): string {
  return `cand_${shortHash(parts)}`;
}

export function derivedIdFor(kind: string, parts: unknown): string {
  return `drv_${kind}_${shortHash(parts)}`;
}

export function lockIdFor(parts: unknown): string {
  return `lock_${shortHash(parts)}`;
}

export function conflictIdFor(parts: unknown): string {
  return `cfl_${shortHash(parts)}`;
}

export function projectIdFor(name: string, createdAt: string, salt: string): string {
  return `prj_${shortHash({ name, createdAt, salt })}`;
}
