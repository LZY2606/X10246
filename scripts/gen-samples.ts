import { writeFileSync } from "node:fs";
import { generateBaselineInputs, revisedSnrScore } from "./src/core/casepack";
import { validateImport } from "./src/core/importer";

const inputs = generateBaselineInputs();
for (const [kind, payload] of Object.entries(inputs)) {
  const v = validateImport(kind, payload);
  if (!v.ok) throw new Error(`sample ${kind} invalid: ${JSON.stringify(v.errors)}`);
  writeFileSync(`samples/${kind}.json`, JSON.stringify({ kind, payload, note: "干涉条纹簿样例" }, null, 1));
}
writeFileSync("samples/snr_score-v2.json", JSON.stringify({ kind: "snr_score", payload: revisedSnrScore(), note: "局部源数据改动样例 v2" }, null, 1));
writeFileSync("samples/bad-format.json", JSON.stringify({ kind: "wrapped_phase", payload: { width: 2, height: 2, values: [1, 2, 3] }, note: "格式错误样例：缺 frame/unit 且长度不符" }, null, 1));
console.log("samples written:", Object.keys(inputs).length + 2);
