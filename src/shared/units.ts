/** 领域量必须携带单位或坐标基准；无法转换的值保留原表示并附诊断。 */
export type Unit = "rad" | "nm" | "um" | "mm" | "deg" | "count" | "pixel";

export interface Quantity {
  value: number;
  unit: Unit;
}

export interface QuantityDiagnostic {
  code: "UNIT_MISMATCH" | "UNCONVERTIBLE";
  message: string;
  original: Quantity;
}

const LENGTH_TO_NM: Record<string, number> = { nm: 1, um: 1e3, mm: 1e6 };

/** 规范化只发生在派生层；失败时返回 null，调用方必须保留原值与诊断。 */
export function toNm(q: Quantity): { nm?: number; diagnostic?: QuantityDiagnostic } {
  const factor = LENGTH_TO_NM[q.unit];
  if (factor === undefined) {
    return { diagnostic: { code: "UNCONVERTIBLE", message: `单位 ${q.unit} 无法转换为 nm，原值保留`, original: q } };
  }
  return { nm: q.value * factor };
}

export interface PixelCoord {
  row: number;
  col: number;
}

/** 坐标基准：所有二维场共享同一像素坐标系声明。 */
export interface Frame2D {
  frameId: string;
  rows: number;
  cols: number;
  origin: "top-left";
  axis: "row-col";
}
