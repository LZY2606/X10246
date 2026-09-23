/** 领域量一律携带单位或坐标基准；原始表示在导入层保留，派生层才规范化。 */
export type Unit = 'rad' | 'nm' | 'um' | 'deg' | 'count' | 'dimensionless';

export interface Quantity<U extends Unit = Unit> {
  value: number;
  unit: U;
}

export function qty<U extends Unit>(value: number, unit: U): Quantity<U> {
  return { value, unit };
}

export interface PixelBasis {
  /** 像素坐标基准：原点与像元尺寸 */
  origin: [number, number];
  spacing: Quantity<'um'>;
}
