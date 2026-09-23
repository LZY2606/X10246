import { contentDigest } from "./digest.js";

/**
 * 稳定身份：由命名空间 + 确定性载荷派生。
 * 同一逻辑对象在导出/删除/再导入后身份不变，因为身份只依赖内容而非数据库自增。
 */
export function stableId(kind: string, ...parts: unknown[]): string {
  const digest = contentDigest(parts).slice("sha256:".length, "sha256:".length + 24);
  return `${kind}_${digest}`;
}
