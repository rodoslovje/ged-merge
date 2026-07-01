/**
 * Round-trip regression suite over the anonymized real-world corpus.
 *
 * Each fixture in `corpus/` is a privacy-scrubbed slice of a real GEDCOM export
 * (see corpus/README.md), deliberately spanning the exporter / charset /
 * version / line-ending matrix. For every one we assert that the app's own
 * parser + serializer:
 *   - detect the right charset, version and line-ending
 *   - reach a stable serialize fixed-point (parse→serialize is idempotent)
 *   - never emit a `syntax` warning (which would mean corruption)
 * plus a privacy tripwire: every personal-name token must come from the fixed
 * pseudonym vocabulary — if a future source leaks a real name, this fails.
 */

/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import type { GedcomCharset, GedNode } from "../gedcom/types";
import { ALLOWED_NAME_WORDS } from "./pseudonyms";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "corpus");

interface FixtureMeta {
  file: string;
  exporter: string;
  version: string;
  charset: "utf-8" | "windows-1250";
  eol: "LF" | "CRLF" | "CR";
  finalNewline: boolean;
  bom: boolean;
  bytes: number;
  records: { INDI: number; FAM: number; other: number };
  note?: string;
}

const manifest: FixtureMeta[] = JSON.parse(
  readFileSync(resolve(DIR, "manifest.json"), "utf-8"),
);

const EOL: Record<FixtureMeta["eol"], string> = { LF: "\n", CRLF: "\r\n", CR: "\r" };

/** Encode text back to a single-byte codepage (or UTF-8), mirroring the source bytes. */
function encode(text: string, charset: GedcomCharset): ArrayBuffer {
  if (charset !== "WINDOWS-1250") return new TextEncoder().encode(text).buffer as ArrayBuffer;
  const dec = new TextDecoder("windows-1250");
  const rev = new Map<string, number>();
  for (let b = 0; b < 256; b++) {
    const ch = dec.decode(Uint8Array.of(b));
    if (ch !== "�" && !rev.has(ch)) rev.set(ch, b);
  }
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[i] = code < 0x80 ? code : (rev.get(text[i]) ?? 0x3f);
  }
  return out.buffer;
}

function readFixture(file: string): ArrayBuffer {
  const buf = readFileSync(resolve(DIR, file));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** Collect every node with one of the given tags, depth-first. */
function collect(records: GedNode[], tags: Set<string>): GedNode[] {
  const out: GedNode[] = [];
  const walk = (n: GedNode) => {
    if (tags.has(n.tag)) out.push(n);
    for (const c of n.children) walk(c);
  };
  records.forEach(walk);
  return out;
}

const words = (s: string): string[] => s.match(/\p{L}+/gu) ?? [];

it("the corpus manifest is present and non-trivial", () => {
  expect(manifest.length).toBeGreaterThanOrEqual(10);
});

describe.each(manifest)("$file", (m) => {
  const parsed = parseGedcom(readFixture(m.file));

  it("detects charset, version and line-ending", () => {
    expect(parsed.charset).toBe(m.charset === "windows-1250" ? "WINDOWS-1250" : "UTF-8");
    expect(parsed.version).toBe(m.version === "7.0" ? "7.0" : "5.5.1");
    expect(parsed.eol).toBe(EOL[m.eol]);
    expect(parsed.finalNewline).toBe(m.finalNewline);
  });

  it("parses to a well-formed record set with no syntax warnings", () => {
    expect(parsed.records.length).toBeGreaterThan(10);
    expect(parsed.records[0].tag).toBe("HEAD");
    expect(parsed.records[parsed.records.length - 1].tag).toBe("TRLR");
    expect(parsed.warnings.filter((w) => w.kind === "syntax")).toEqual([]);
  });

  it("serializes to a stable fixed-point (parse→serialize is idempotent)", () => {
    const opts = { eol: parsed.eol, finalNewline: parsed.finalNewline };
    const text1 = serializeGedcom(parsed.records, opts);
    const reparsed = parseGedcom(encode(text1, parsed.charset));
    const text2 = serializeGedcom(reparsed.records, opts);
    expect(text2).toBe(text1);
  });

  it("contains no un-anonymized personal names", () => {
    const leaks = new Set<string>();
    // NAME: check the given part + the surname between the slashes.
    for (const n of collect(parsed.records, new Set(["NAME"]))) {
      const mm = /^([^/]*)(?:\/([^/]*)\/)?/.exec(n.value ?? "");
      for (const w of [...words(mm?.[1] ?? ""), ...words(mm?.[2] ?? "")]) {
        if (!ALLOWED_NAME_WORDS.has(w.toLowerCase())) leaks.add(w);
      }
    }
    // Structured name sub-tags.
    for (const n of collect(parsed.records, new Set(["GIVN", "SURN", "NICK", "_MARNM", "_AKA", "SPFX"]))) {
      for (const w of words(n.value ?? "")) {
        if (!ALLOWED_NAME_WORDS.has(w.toLowerCase())) leaks.add(w);
      }
    }
    expect([...leaks]).toEqual([]);
  });
});
