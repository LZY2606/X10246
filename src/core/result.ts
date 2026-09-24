export interface Diagnostic {
  code: string;
  message: string;
  at?: string;
}

export class CorruptReferenceError extends Error {
  constructor(
    public readonly ownerId: string,
    public readonly missingRef: string,
    public readonly role: string,
  ) {
    super(
      `CORRUPT: ${ownerId} references missing ${role}=${missingRef}; refusing to fall back to latest`,
    );
    this.name = 'CorruptReferenceError';
  }
}

export class FormatError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = 'FormatError';
  }
}
