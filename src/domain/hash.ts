/**
 * 稳定身份：内容寻址哈希。
 * - canonicalJson 对键排序、保证 NaN/undefined 处理确定；
 * - 内容对象 C<sha256> 在“导出→删除本地库→导入”后保持不变；
 * - 事件 id 引用其内容 id、前序事件与序号，顺序也是身份的一部分。
 */
import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stableify(value));
}

function stableify(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
    return value;
  }
  if (Array.isArray(value)) return value.map(stableify);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    out[key] = stableify(v);
  }
  return out;
}

export function sha256Hex(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function contentHash(value: unknown): string {
  return 'C' + sha256Hex(canonicalJson(value));
}

/**
 * 事件/记录身份：对“类型 + 项目 + 父版本 + 序号 + 内容哈希”做哈希。
 * parentSeq/parentId 保证顺序与来源关系进入身份；跨导出/导入重算结果一致，
 * 因为这些字段全部随档案保存。
 */
export function eventId(input: {
  type: string;
  projectId: string;
  seq: number;
  parentEventId: string | null;
  payloadContentId: string;
}): string {
  return (
    'E' +
    sha256Hex(
      canonicalJson({
        t: input.type,
        p: input.projectId,
        s: input.seq,
        par: input.parentEventId,
        c: input.payloadContentId,
      }),
    )
  );
}

export function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 4) + '…' + id.slice(-6) : id;
}
