/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { en } from "./en";
import { sl } from "./sl";
import { hr } from "./hr";

/**
 * The locale maps against each other, and against the code that asks them.
 *
 * Neither map is typed against the other, and `t()` takes any string: a key
 * used in code and defined nowhere shows the reader the raw key — as the
 * place-flows CSV's column header did (`stats.csv.pairs`) — and nothing
 * failed. These tests are what fails.
 */

/** The suffixes i18next adds to a base key: plural forms, and the contexts the
 *  app asks for (a sex, a grammatical case, a narrative variant). */
const SUFFIX = /_(?:zero|one|two|few|many|other|M|F|Mp|Fp|gen)$/;
const base = (key: string): string => {
  let k = key;
  while (SUFFIX.test(k)) k = k.replace(SUFFIX, "");
  return k;
};
const bases = (map: Record<string, string>) => new Set(Object.keys(map).map(base));

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "locales" && entry.name !== "__fixtures__") sourceFiles(path, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Every key written out as a literal in a call to a translate function:
 *  `t("a.b")`, `tRef.current("a.b")`, `i18n.t("a.b")`. A key built at run time
 *  (`t(\`event.${tag}\`)`) cannot be read off the page and is not checked. */
function usedKeys(): Map<string, string> {
  const used = new Map<string, string>();
  const call = /(?:\bt|\btr|\.t|\.current|\btranslate)\(\s*(["'])((?:[A-Za-z0-9_]+[.:])+[A-Za-z0-9_-]+)\1/g;
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf-8");
    for (const m of text.matchAll(call)) if (!used.has(m[2])) used.set(m[2], file.slice(SRC.length + 1));
  }
  return used;
}

describe("locale keys", () => {
  it("every English key has a Slovenian one, and the other way round", () => {
    const enBases = bases(en);
    const slBases = bases(sl);
    expect([...enBases].filter((k) => !slBases.has(k)), "in en.ts, missing from sl.ts").toEqual([]);
    expect([...slBases].filter((k) => !enBases.has(k)), "in sl.ts, missing from en.ts").toEqual([]);
  });

  it("every English key has a Croatian one, and the other way round", () => {
    const enBases = bases(en);
    const hrBases = bases(hr);
    expect([...enBases].filter((k) => !hrBases.has(k)), "in en.ts, missing from hr.ts").toEqual([]);
    expect([...hrBases].filter((k) => !enBases.has(k)), "in hr.ts, missing from en.ts").toEqual([]);
  });

  it("a Croatian string keeps the placeholders of its Slovenian twin", () => {
    // Both translate the English; the Slovenian has Croatian's gender and
    // case variants, so it is the key-for-key reference. The tag meaning is
    // one sanctioned drift: {{meaningSl}} ↔ {{meaningHr}}. A Croatian `_one`
    // also covers 21, 31 …, so it may show {{count}} where the Slovenian
    // singular need not.
    const slMap: Record<string, string> = sl;
    const names = (s: string) =>
      [...new Set([...s.matchAll(/\{\{\s*([A-Za-z0-9_]+)/g)].map((m) => m[1].replace(/^meaning(Sl|Hr)$/, "meaning")))]
        .filter((n) => n !== "count")
        .sort()
        .join();
    const drift = Object.entries(hr).filter(([key, text]) => key in slMap && names(text) !== names(slMap[key]));
    expect(drift.map(([key]) => key)).toEqual([]);
  });

  it("a Croatian count has exactly Croatian's forms: one, few, other", () => {
    expect(Object.keys(hr).filter((k) => k.endsWith("_two"))).toEqual([]);
    const plural = /_(one|few|other)$/;
    const stems = new Set(Object.keys(hr).filter((k) => plural.test(k)).map((k) => k.replace(plural, "")));
    const missing = [...stems].flatMap((s) => [`${s}_one`, `${s}_few`, `${s}_other`]).filter((k) => !(k in hr));
    expect(missing).toEqual([]);
  });

  it("every key the code asks for by name is defined", () => {
    const defined = bases(en);
    const used = usedKeys();
    // The scan itself is under test too: a pattern that stopped matching
    // would find nothing missing.
    expect(used.size).toBeGreaterThan(1500);
    const missing = [...used].filter(([key]) => !defined.has(base(key))).map(([key, file]) => `${key} (${file})`);
    expect(missing).toEqual([]);
  });
});
