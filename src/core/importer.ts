/** 导入层：接受可复制的小型样例，格式错误给出明确诊断；原始表示原样保留。 */
import { INPUT_KINDS, type InputKind, type GridPayload } from "../domain/types";
import { UNITS } from "../domain/units";

export interface ImportError {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; kind: InputKind; payload: unknown }
  | { ok: false; errors: ImportError[] };

function isGrid(v: unknown): v is GridPayload {
  const g = v as GridPayload;
  return (
    !!g &&
    typeof g.width === "number" &&
    typeof g.height === "number" &&
    g.width > 0 &&
    g.height > 0 &&
    Array.isArray(g.values) &&
    g.values.length === g.width * g.height &&
    g.values.every((x) => typeof x === "number" && Number.isFinite(x))
  );
}

export function validateImport(kind: string, payload: unknown): ValidationResult {
  const errors: ImportError[] = [];
  if (!INPUT_KINDS.includes(kind as InputKind)) {
    return { ok: false, errors: [{ path: "kind", message: `未知输入种类 '${kind}'，应为 ${INPUT_KINDS.join("/")}` }] };
  }
  const k = kind as InputKind;
  const p = payload as Record<string, unknown>;
  switch (k) {
    case "wrapped_phase":
    case "snr_score":
    case "invalid_mask": {
      if (!isGrid(payload)) {
        errors.push({ path: "payload", message: "网格载荷需含 width/height/values，且 values 长度等于 width*height" });
      } else {
        if (!UNITS[(payload as GridPayload).unit]) {
          errors.push({ path: "payload.unit", message: `未知单位 '${(payload as GridPayload).unit}'` });
        }
        if ((payload as GridPayload).frame !== "sensor-pixel") {
          errors.push({ path: "payload.frame", message: "网格坐标基准必须为 sensor-pixel" });
        }
        if (k === "invalid_mask" && !(payload as GridPayload).values.every((v) => v === 0 || v === 1)) {
          errors.push({ path: "payload.values", message: "无效遮罩取值只能为 0 或 1" });
        }
        if (k === "wrapped_phase" && !(payload as GridPayload).values.every((v) => v > -Math.PI - 1e-9 && v <= Math.PI + 1e-9)) {
          errors.push({ path: "payload.values", message: "包裹相位必须位于 (-π, π]" });
        }
      }
      break;
    }
    case "wavelength": {
      const q = p?.wavelength as { value?: unknown; unit?: unknown };
      if (typeof q?.value !== "number" || !(q.value > 0)) errors.push({ path: "wavelength.value", message: "波长需为正数" });
      if (typeof q?.unit !== "string" || !UNITS[q.unit]) errors.push({ path: "wavelength.unit", message: `波长单位未知：${String(q?.unit)}` });
      break;
    }
    case "incidence_geometry": {
      const a = p?.incidenceAngle as { value?: unknown; unit?: unknown };
      if (typeof a?.value !== "number") errors.push({ path: "incidenceAngle.value", message: "入射角需为数值" });
      if (typeof a?.unit !== "string" || !UNITS[a.unit]) errors.push({ path: "incidenceAngle.unit", message: "入射角单位未知" });
      break;
    }
    case "calibration_surface": {
      if (typeof p?.reference !== "string") errors.push({ path: "reference", message: "标定面需引用标定帧身份" });
      const f = p?.flatness as { value?: unknown };
      if (typeof f?.value !== "number") errors.push({ path: "flatness.value", message: "平面度需为数值" });
      break;
    }
    case "cut_edit_history": {
      if (!Array.isArray(p?.entries)) {
        errors.push({ path: "entries", message: "切口编辑历史需为条目数组" });
      } else {
        (p.entries as unknown[]).forEach((e, i) => {
          const en = e as { edge?: unknown; action?: unknown };
          if (!Array.isArray(en.edge) || en.edge.length !== 2) errors.push({ path: `entries[${i}].edge`, message: "切口边需为像素索引对" });
          if (en.action !== "add-cut" && en.action !== "remove-cut") errors.push({ path: `entries[${i}].action`, message: "动作需为 add-cut/remove-cut" });
        });
      }
      break;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, kind: k, payload };
}
