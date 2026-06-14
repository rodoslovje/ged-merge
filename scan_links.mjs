import { readFileSync } from "fs";
import { parseGedcom } from "./src/gedcom/parser.ts";
import { buildDataset } from "./src/gedcom/builder.ts";

const files = process.argv.slice(2);
for (const f of files) {
  const buf = readFileSync(f);
  const parsed = parseGedcom(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const ds = buildDataset(parsed);
  const all = [];
  for (const [id, indi] of ds.individuals) {
    all.push(...(indi.links ?? []).map(l=>[id,l]));
    for (const e of indi.events) all.push(...(e.links ?? []).map(l=>[id,l]));
  }
  for (const [id, fam] of ds.families) {
    all.push(...(fam.links ?? []).map(l=>[id,l]));
    for (const e of fam.events) all.push(...(e.links ?? []).map(l=>[id,l]));
  }
  for (const [id, l] of all) {
    // flag: contains newline, very long (likely base64), or doesn't start with scheme/www
    if (l.includes("\n") || l.length > 300 || !/^(https?:\/\/|www\.)/i.test(l)) {
      console.log(f, id, l.length, JSON.stringify(l.slice(0,120)));
    }
  }
}
