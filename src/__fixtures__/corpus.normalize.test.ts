/**
 * Whole-pipeline normalization idempotence over the anonymized corpus.
 *
 * Loading the same compare file twice — or re-normalizing an already
 * normalized dataset (a main reload re-feeds the kept compare) — must be a
 * fixed point: the second pass may change nothing. Idempotence was previously
 * pinned only for the place-reformat pass in isolation; a real regression
 * (AGNC re-append) once slipped through exactly this gap. Byte-comparing the
 * serialized output is stronger than trusting the report's counters.
 */

/// <reference types="node" />
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { buildDataset } from "../gedcom/builder";
import { inferMainProfile } from "../normalize/profile";
import { normalizeDataset } from "../normalize/normalize";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "corpus");
const fixtures = readdirSync(DIR).filter((f) => f.endsWith(".ged"));

// Every corpus file doubles as the incoming side, normalized against the
// profile of one fixed "house style" main — the strictest cross-exporter mix.
const MAIN_FIXTURE = "gramps-5.5.1-utf8.ged";

function load(file: string) {
  const buffer = readFileSync(resolve(DIR, file));
  return buildDataset(parseGedcom(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)));
}

describe("normalizeDataset is idempotent over the corpus", () => {
  const profile = inferMainProfile(load(MAIN_FIXTURE));

  for (const file of fixtures) {
    it(`${file} reaches a fixed point after one pass`, () => {
      const raw = load(file);
      const once = normalizeDataset(raw, profile).dataset;
      const twice = normalizeDataset(once, profile).dataset;
      expect(serializeGedcom(twice.records)).toBe(serializeGedcom(once.records));
    });
  }

  it("normalizing against the file's own profile is idempotent too", () => {
    // The self-profile case: a compare in the main's exact house style must
    // pass through with a stable result as well.
    for (const file of fixtures) {
      const raw = load(file);
      const own = inferMainProfile(load(file));
      const once = normalizeDataset(raw, own).dataset;
      const twice = normalizeDataset(once, own).dataset;
      expect(serializeGedcom(twice.records), file).toBe(serializeGedcom(once.records));
    }
  });
});
