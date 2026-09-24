/** 引用损坏：缺少被引用的版本或内容摘要不符。绝不退回当前最新版。 */
export class CorruptReferenceError extends Error {
  readonly code = 'CORRUPT_REFERENCE';
  constructor(
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'CorruptReferenceError';
  }
}

/** 试图覆盖不可变输入。 */
export class ImmutableOverwriteError extends Error {
  readonly code = 'IMMUTABLE_OVERWRITE';
  constructor(message: string) {
    super(message);
    this.name = 'ImmutableOverwriteError';
  }
}

export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ImportFormatError extends Error {
  readonly code = 'IMPORT_FORMAT';
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`导入格式错误: ${problems.join('; ')}`);
    this.name = 'ImportFormatError';
    this.problems = problems;
  }
}
