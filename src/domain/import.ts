import type { Grid2D, InputEntity, InputEntityKind, IntegrityDiagnostic, Quantity } from "./types";

export interface ParsedBundle {
  entities: InputEntity[];
  diagnostics: IntegrityDiagnostic[];
}

/** 接受可复制的小型 JSON 样例；任何格式错误都明确报告，不静默丢弃。 */
export function parseBundle(rawText: string): ParsedBundle {
  const diagnostics: IntegrityDiagnostic[] = [];
  let doc: unknown;
  try {
    doc = JSON.parse(rawText);
  } catch (e) {
    return {
      entities: [],
      diagnostics: [
        {
          code: "IMPORT_FORMAT_ERROR",
          ref: "<document>",
          message: `JSON 无法解析: ${(e as Error).message}`,
        },
      ],
    };
  }
  const root = doc as { entities?: unknown };
  if (!root || typeof root !== "object" || !Array.isArray(root.entities)) {
    return {
      entities: [],
      diagnostics: [
        { code: "IMPORT_FORMAT_ERROR", ref: "<document>", message: "缺少 entities 数组" },
      ],
    };
  }

  const entities: InputEntity[] = [];
  root.entities.forEach((ent, i) => {
    const ref = `entities[${i}]`;
    const e = ent as Partial<InputEntity>;
    if (!e || typeof e !== "object") {
      diagnostics.push({ code: "IMPORT_FORMAT_ERROR", ref, message: "实体必须是对象" });
      return;
    }
    if (!isKind(e.kind)) {
      diagnostics.push({ code: "IMPORT_FORMAT_ERROR", ref: `${ref}.kind`, message: `未知实体类型: ${String(e.kind)}` });
      return;
    }
    if (typeof e.rawRepresentation !== "string" || e.rawRepresentation.length === 0) {
      diagnostics.push({ code: "IMPORT_FORMAT_ERROR", ref: `${ref}.rawRepresentation`, message: "必须提供原始表示字符串" });
      return;
    }
    const gridKinds: InputEntityKind[] = ["wrapped_phase", "amplitude", "snr_score", "invalid_mask"];
    if (gridKinds.includes(e.kind)) {
      const gerr = validateGrid(e.payload as Grid2D);
      if (gerr) {
        diagnostics.push({ code: "IMPORT_FORMAT_ERROR", ref: `${ref}.payload`, message: gerr });
        return;
      }
    }
    entities.push({
      kind: e.kind,
      payload: e.payload,
      unit: typeof e.unit === "string" ? e.unit : undefined,
      datum: typeof e.datum === "string" ? e.datum : undefined,
      rawRepresentation: e.rawRepresentation,
    });
  });

  return { entities, diagnostics };
}

function isKind(k: unknown): k is InputEntityKind {
  return (
    k === "wrapped_phase" ||
    k === "amplitude" ||
    k === "snr_score" ||
    k === "invalid_mask" ||
    k === "wavelength" ||
    k === "incidence_geometry" ||
    k === "calibration_plane" ||
    k === "cut_edit_history"
  );
}

function validateGrid(g: Grid2D): string | null {
  if (!g || typeof g !== "object") return "网格必须是对象";
  if (!Number.isInteger(g.rows) || !Number.isInteger(g.cols) || g.rows <= 0 || g.cols <= 0)
    return "rows/cols 必须为正整数";
  if (!Array.isArray(g.data) || g.data.length !== g.rows * g.cols)
    return `data 长度必须等于 rows*cols=${g.rows * g.cols}`;
  if (!g.data.every((v) => typeof v === "number")) return "data 必须全部为数字（缺失用 NaN）";
  if (!g.unit) return "网格必须携带 unit";
  return null;
}

export function importableQuantity(q: Quantity): { normalized?: Quantity; diagnostic?: string } {
  return q.conversionDiagnostic ? { diagnostic: q.conversionDiagnostic } : { normalized: q };
}
