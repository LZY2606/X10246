import { createHash } from "node:crypto";
import { stableStringify } from "./canonical.js";

export function sha256Hex(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function contentId(prefix: string, body: unknown): string {
  return `${prefix}_${sha256Hex(body).slice(0, 20)}`;
}
