/** 生成离线案例包 JSON：仓库自带，禁止用通用表格替代领域材料。 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { replayCase } from "../src/core/replay.ts";
import { canonicalJson } from "../src/shared/hash.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { bundle } = replayCase();
const outDir = join(here, "pack");
mkdirSync(outDir, { recursive: true });
const target = join(outDir, "interfero-ledger-case.json");
writeFileSync(target, canonicalJson(bundle));

const summary = {
  events: bundle.events.length,
  entities: bundle.entities.length,
  blobs: Object.keys(bundle.blobs).length,
  scenarios: Object.keys(bundle.counterExampleArchive.records),
  project: bundle.project.projectId,
  headSeq: bundle.project.headSeq
};
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
