import { sha256 } from './hash.ts';
import type { EntityKind } from './types.ts';

/**
 * Stable, content-derived identities. Because ids are deterministic functions
 * of (project, kind, role key, content), an export -> delete -> import rebuilds
 * exactly the same ids, preserving identity, order and source relations.
 */

export function projectId(seed: string): string {
  return `prj_${sha256(`project:${seed}`).slice(0, 16)}`;
}

/** Source entities: stable per role key (wrapped_phase#main ...). Versions bump. */
export function sourceEntityId(projectId: string, kind: EntityKind, key: string): string {
  return `${projectId}:${kind}:${key}`;
}

export function fragmentId(projectId: string, digest: string): string {
  return `${projectId}:frag:${digest.slice(0, 16)}`;
}

/** Derived entities keyed by the exact algorithm + sources so reruns converge. */
export function derivedEntityId(
  projectId: string,
  kind: EntityKind,
  basis: unknown,
): string {
  return `${projectId}:${kind}:${sha256(basis).slice(0, 16)}`;
}

export function lockId(projectId: string, anchorCell: number, basis: unknown): string {
  return `${projectId}:local_lock:cell${anchorCell}:${sha256(basis).slice(0, 8)}`;
}

export function eventId(projectId: string, seq: number, prevEventId: string | null, payload: unknown): string {
  return `${projectId}:evt:${String(seq).padStart(4, '0')}:${sha256([prevEventId, seq, payload]).slice(0, 12)}`;
}
