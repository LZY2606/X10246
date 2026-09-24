export class ImportFormatError extends Error {
  code: string;
  path: string;
  constructor(code: string, message: string, path = '$') {
    super(`${code} at ${path}: ${message}`);
    this.name = 'ImportFormatError';
    this.code = code;
    this.path = path;
  }
}

export class CorruptionError extends Error {
  code: string;
  refs: string[];
  constructor(code: string, message: string, refs: string[] = []) {
    super(message);
    this.name = 'CorruptionError';
    this.code = code;
    this.refs = refs;
  }
}

export class ConflictError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConflictError';
    this.code = code;
  }
}
