/** 引用损坏：缺少引用、版本不存在或内容摘要不匹配；禁止回退最新版 */
export class CorruptReferenceError extends Error {
  constructor(
    message: string,
    readonly missing?: { entityId: string; version: number }
  ) {
    super(message);
    this.name = 'CorruptReferenceError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class ImmutableViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImmutableViolationError';
  }
}
