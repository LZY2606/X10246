/** 跨环境 sql.js 抽象：Node 与浏览器各自提供初始化函数 */
export type SqlJsStatic = any;
export interface DatabaseLike {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  prepare(sql: string): StmtLike;
  export(): Uint8Array;
  close(): void;
}
export interface StmtLike {
  bind(params?: unknown[]): boolean;
  step(): boolean | number;
  getAsObject(): Record<string, unknown>;
  free(): boolean;
}
