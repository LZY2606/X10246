import { INPUT_KINDS, type InputKind, type InputPayload } from "./types.js";

export interface FormatError {
  path: string;
  message: string;
}

/** 导入层校验：接受可复制的小型样例，格式错误给出明确路径与原因。 */
export function validateInputPayload(raw: unknown): { payload?: InputPayload; errors: FormatError[] } {
  const errors: FormatError[] = [];
  if (typeof raw !== "object" || raw === null) {
    return { errors: [{ path: "$", message: "载荷必须是对象" }] };
  }
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind;
  if (typeof kind !== "string" || !(INPUT_KINDS as string[]).includes(kind)) {
    return { errors: [{ path: "$.kind", message: `kind 必须是 ${INPUT_KINDS.join(" | ")} 之一` }] };
  }
  const k = kind as InputKind;

  const needFrame = (field: string, len: number) => {
    const frame = obj.frame as Record<string, unknown> | undefined;
    if (!frame || typeof frame.rows !== "number" || typeof frame.cols !== "number") {
      errors.push({ path: "$.frame", message: "frame 必须声明 rows/cols 坐标基准" });
      return;
    }
    if (frame.origin !== "top-left" || frame.axis !== "row-col") {
      errors.push({ path: "$.frame", message: "frame.origin 必须为 top-left，frame.axis 必须为 row-col" });
    }
    const arr = obj[field];
    if (!Array.isArray(arr) || arr.length !== len) {
      errors.push({ path: `$.${field}`, message: `${field} 长度必须为 rows*cols=${len}` });
    }
  };

  switch (k) {
    case "wrapped-phase-field": {
      const frame = obj.frame as { rows?: number; cols?: number } | undefined;
      const len = (frame?.rows ?? 0) * (frame?.cols ?? 0);
      needFrame("phaseRad", len);
      if (Array.isArray(obj.phaseRad)) {
        (obj.phaseRad as unknown[]).forEach((v, i) => {
          if (typeof v !== "number" || v <= -Math.PI || v > Math.PI + 1e-9) {
            errors.push({ path: `$.phaseRad[${i}]`, message: "包裹相位必须在 (-π, π] 内" });
          }
        });
      }
      break;
    }
    case "amplitude-quality-map": {
      const frame = obj.frame as { rows?: number; cols?: number } | undefined;
      needFrame("snrScore", (frame?.rows ?? 0) * (frame?.cols ?? 0));
      if (typeof obj.guessFloor !== "number" || obj.guessFloor < 0 || obj.guessFloor > 1) {
        errors.push({ path: "$.guessFloor", message: "guessFloor 必须在 [0,1]" });
      }
      break;
    }
    case "invalid-mask": {
      const frame = obj.frame as { rows?: number; cols?: number } | undefined;
      needFrame("invalid", (frame?.rows ?? 0) * (frame?.cols ?? 0));
      break;
    }
    case "wavelength-spec": {
      const w = obj.wavelength as { value?: unknown; unit?: unknown } | undefined;
      if (!w || typeof w.value !== "number" || w.value <= 0 || !["nm", "um", "mm"].includes(String(w.unit))) {
        errors.push({ path: "$.wavelength", message: "wavelength 需要正的 value 与单位 nm|um|mm" });
      }
      if (typeof obj.source !== "string") errors.push({ path: "$.source", message: "source 必填（标定来源）" });
      break;
    }
    case "incident-geometry": {
      const a = obj.incidenceAngle as { value?: unknown; unit?: unknown } | undefined;
      if (!a || typeof a.value !== "number" || a.unit !== "deg") {
        errors.push({ path: "$.incidenceAngle", message: "incidenceAngle 需要 value 与单位 deg" });
      }
      if (obj.mode !== "reflection" && obj.mode !== "transmission") {
        errors.push({ path: "$.mode", message: "mode 必须为 reflection|transmission" });
      }
      break;
    }
    case "calibration-plane": {
      for (const f of ["tiltX", "tiltY", "offset"]) {
        const q = obj[f] as { value?: unknown; unit?: unknown } | undefined;
        if (!q || typeof q.value !== "number" || q.unit !== "um") {
          errors.push({ path: `$.${f}`, message: `${f} 需要 value 与单位 um` });
        }
      }
      break;
    }
    case "cut-edit-history": {
      if (!Array.isArray(obj.edits)) {
        errors.push({ path: "$.edits", message: "edits 必须为数组" });
      } else {
        (obj.edits as unknown[]).forEach((e, i) => {
          const ed = e as { op?: unknown; cutId?: unknown; path?: unknown };
          if (ed.op !== "add-cut" && ed.op !== "remove-cut") {
            errors.push({ path: `$.edits[${i}].op`, message: "op 必须为 add-cut|remove-cut" });
          }
          if (typeof ed.cutId !== "string") errors.push({ path: `$.edits[${i}].cutId`, message: "cutId 必填" });
          if (ed.op === "add-cut" && !Array.isArray(ed.path)) {
            errors.push({ path: `$.edits[${i}].path`, message: "add-cut 需要 path" });
          }
        });
      }
      break;
    }
  }
  if (errors.length > 0) return { errors };
  return { payload: obj as unknown as InputPayload, errors: [] };
}
