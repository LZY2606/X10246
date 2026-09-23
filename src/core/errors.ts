export class DomainError extends Error {
  override name = 'DomainError';
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Original inputs are append-only; a matching entity cannot be overwritten. */
export class ImmutableInputError extends DomainError {
  constructor(entityId: string) {
    super(
      `immutable source entity ${entityId} cannot be overwritten; submit a new version with a parent`,
      'IMMUTABLE_INPUT',
      { entityId },
    );
    this.name = 'ImmutableInputError';
  }
}

/** A derived version references an entity/version that is missing or mismatched. */
export class CorruptReferenceError extends DomainError {
  constructor(missing: RefSpec[]) {
    super(
      'one or more references are missing or digest-mismatched; refusing to fall back to latest',
      'CORRUPT_REFERENCE',
      { missing },
    );
    this.name = 'CorruptReferenceError';
  }
}

export interface RefSpec {
  entityId: string;
  version: number;
  digest?: string;
}

/** A source payload is not a valid, copy-pasteable domain sample. */
export class ImportFormatError extends DomainError {
  constructor(message: string, details?: unknown) {
    super(message, 'IMPORT_FORMAT', details);
    this.name = 'ImportFormatError';
  }
}

/** A human decision conflicts with an existing local lock. */
export class LockConflictError extends DomainError {
  constructor(
    readonly existingLockId: string,
    readonly attemptedLockId: string,
  ) {
    super(
      `local lock conflict: ${attemptedLockId} contradicts accepted lock ${existingLockId}`,
      'LOCK_CONFLICT',
      { existingLockId, attemptedLockId },
    );
    this.name = 'LockConflictError';
  }
}

/** A requested action is not valid for the entity's current state. */
export class StateMachineError extends DomainError {
  constructor(message: string, details?: unknown) {
    super(message, 'STATE_MACHINE', details);
    this.name = 'StateMachineError';
  }
}
