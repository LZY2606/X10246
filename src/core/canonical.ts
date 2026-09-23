/**
 * 规范化 JSON：所有内容寻址（内容 ID、参数指纹、事件哈希）都基于它，
 * 保证导出→删除本地数据库→重新导入后身份完全一致。
 */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("canonicalJSON: 拒绝非有限数（NaN/Infinity），请改用显式未知状态");
  }
  return value;
}
