import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { downloadOptions, serializeGedcom } from "../gedcom/serialize";
import type { Dataset, GedNode } from "../gedcom/types";
import { ChangeJournal } from "../state/mainSync";
import { SerializedMain } from "./serializedMain";

const corpus = resolve(dirname(fileURLToPath(import.meta.url)), "../__fixtures__/corpus");
const load = (bytes: ArrayBuffer | Uint8Array): Dataset => {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return buildDataset(parseGedcom(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer));
};
const whole = (ds: Dataset) => serializeGedcom(ds.records, downloadOptions(ds));
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
const encode = (text: string) => new TextEncoder().encode(text);
/** Compared as a boolean: a deep equality of megabytes is slow, and its diff slower. */
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** A large file of plain people, so it spans many chunks. */
function bigFile(n: number, eol = "\n", finalNewline = true): string {
  const lines = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8"];
  for (let i = 1; i <= n; i++) lines.push(`0 @I${i}@ INDI`, `1 NAME Oseba${i} /Novak/`, "1 BIRT", `2 DATE ${1 + (i % 28)} JAN 1850`);
  lines.push("0 TRLR");
  return lines.join(eol) + (finalNewline ? eol : "");
}

describe("SerializedMain", () => {
  it("writes every corpus file byte for byte as serializeGedcom does", async () => {
    for (const file of readdirSync(corpus).filter((f) => f.endsWith(".ged"))) {
      const ds = load(readFileSync(resolve(corpus, file)));
      const blob = new SerializedMain().blob(ds, new ChangeJournal(), 0);
      expect(sameBytes(await bytesOf(blob), encode(whole(ds))), file).toBe(true);
    }
  });

  it("keeps the byte-order mark, CRLF endings and a missing final newline", async () => {
    for (const [eol, finalNewline] of [["\r\n", false], ["\n", true], ["\r\n", true]] as const) {
      const text = bigFile(5000, eol, finalNewline);
      const ds = load(new Uint8Array([0xef, 0xbb, 0xbf, ...encode(text)]));
      expect(ds.bom).toBe(true);
      const blob = new SerializedMain().blob(ds, new ChangeJournal(), 0);
      expect(sameBytes(await bytesOf(blob), encode(whole(ds)))).toBe(true);
      expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(await bytesOf(blob))).toBe("﻿" + text);
    }
  });

  it("follows edited, added, removed and moved records", async () => {
    const ds = load(encode(bigFile(9000)));
    const journal = new ChangeJournal();
    const cache = new SerializedMain();
    let version = 0;
    const check = async () => expect(new TextDecoder().decode(await bytesOf(cache.blob(ds, journal, version)))).toBe(whole(ds));
    const find = (xref: string) => ds.records.find((r) => r.xref === xref)!;
    const bump = (ids: string[] | null) => journal.record(++version, ids);
    await check();

    // An edit in place: the record keeps its object, only the journal knows.
    find("@I4500@").children[0].value = "Spremenjena /Oseba/";
    bump(["@I4500@"]);
    await check();

    // Added up front, removed from the middle, moved to the end.
    const added: GedNode = { level: 0, xref: "@I99999@", tag: "INDI", children: [{ level: 1, tag: "NAME", value: "Nova /Oseba/", children: [] }] };
    ds.records.splice(1, 0, added);
    ds.records.splice(ds.records.indexOf(find("@I3000@")), 1);
    const moved = find("@I10@");
    ds.records.splice(ds.records.indexOf(moved), 1);
    ds.records.splice(ds.records.length - 1, 0, moved);
    bump(["@I99999@", "@I3000@"]); // a removal and an insertion are journaled; the move is not
    await check();

    // Undo of the edit swaps a fresh object in.
    const restored = structuredClone(find("@I4500@"));
    restored.children[0].value = "Oseba4500 /Novak/";
    ds.records[ds.records.indexOf(find("@I4500@"))] = restored;
    bump(["@I4500@"]);
    await check();

    // A save's rebuild: everything may have changed.
    ds.records[0].children.push({ level: 1, tag: "NOTE", value: "saved", children: [] });
    bump(null);
    await check();
  });

  it("starts over for another dataset", async () => {
    const journal = new ChangeJournal();
    const cache = new SerializedMain();
    const a = load(encode(bigFile(3000)));
    const b = load(encode(bigFile(3000).replace("Oseba7 ", "Drugačna ")));
    await bytesOf(cache.blob(a, journal, 0));
    expect(new TextDecoder().decode(await bytesOf(cache.blob(b, journal, 0)))).toBe(whole(b));
  });
});
