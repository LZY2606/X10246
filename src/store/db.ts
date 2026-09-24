import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "./schema.sql.js";

export function openDatabase(filename: string): DatabaseSync {
  if (filename !== ":memory:") {
    mkdirSync(dirname(filename), { recursive: true });
  }
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA_SQL);
  return db;
}

export class CorruptArchiveError extends Error {
  constructor(
    readonly code:
      | "MISSING_REFERENCED_VERSION"
      | "MISSING_BLOB"
      | "FINGERPRINT_MISMATCH"
      | "EVENT_GAP"
      | "PAYLOAD_MISMATCH",
    message: string,
    readonly ref?: { entityId: string; version: number }
  ) {
    super(message);
    this.name = "CorruptArchiveError";
  }
}
