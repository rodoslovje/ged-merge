import { describe, expect, it } from "vitest";
import { parseGedcom } from "../../gedcom/parser";
import { buildDataset } from "../../gedcom/builder";
import { childText, firstChild } from "../../gedcom/node";
import { createStandaloneSource, pageObjeTitle } from "./standaloneSource";

function buildFromText(text: string) {
  const buf = new TextEncoder().encode(text);
  const parsed = parseGedcom(buf.buffer);
  return buildDataset(parsed);
}

const BASE = [
  "0 HEAD",
  "1 GEDC",
  "2 VERS 5.5.1",
  "0 @I1@ INDI",
  "1 NAME Janez /Novak/",
  "1 SEX M",
  "0 TRLR",
  "",
].join("\n");

describe("createStandaloneSource", () => {
  it("creates a SOUR record cited by nothing, with an OBJE for the URL", () => {
    const ds = buildFromText(BASE);
    const { sourceXref, pageObjeXref, extraPatches } = createStandaloneSource(
      ds.records,
      { title: "Krstna knjiga", author: "Župnija Šenčur", url: "https://example.com/book/?pg=11", page: "11" },
      { sourceLayout: "auto" },
    );

    const source = ds.records.find((r) => r.tag === "SOUR" && r.xref === sourceXref)!;
    expect(childText(source, "TITL")).toBe("Krstna knjiga");
    expect(childText(source, "AUTH")).toBe("Župnija Šenčur");
    expect(firstChild(source, "OBJE")?.value).toBe(pageObjeXref);
    expect(ds.records.some((r) => r.tag === "OBJE" && r.xref === pageObjeXref)).toBe(true);
    // Nothing cites the new source — it stands alone in the file.
    expect(ds.records.some((r) => r.children.some((c) => c.tag === "SOUR" && c.value === sourceXref))).toBe(false);

    // Every created record carries an undoable before:null patch.
    const created = extraPatches.filter((p) => p.type === "record" && p.before === null).map((p) => p.id);
    expect(created).toContain(sourceXref);
    expect(created).toContain(pageObjeXref);
  });

  it("creates a title-only source without any OBJE", () => {
    const ds = buildFromText(BASE);
    const { sourceXref, pageObjeXref, extraPatches } = createStandaloneSource(
      ds.records,
      { title: "Družinski arhiv Novak" },
      { sourceLayout: "auto" },
    );
    expect(pageObjeXref).toBeUndefined();
    expect(ds.records.some((r) => r.tag === "OBJE")).toBe(false);
    expect(extraPatches).toHaveLength(1);
    expect(extraPatches[0].id).toBe(sourceXref);
  });

  it("writes PLAC on the record for a hand-entered place", () => {
    const ds = buildFromText(BASE);
    const { sourceXref } = createStandaloneSource(
      ds.records,
      { title: "Poročna knjiga", place: "Kranj" },
      { sourceLayout: "auto" },
    );
    const source = ds.records.find((r) => r.tag === "SOUR" && r.xref === sourceXref)!;
    expect(childText(source, "PLAC")).toBe("Kranj");
  });
});

describe("pageObjeTitle", () => {
  it("titles a recognized site's page image as `#page - title`", () => {
    expect(pageObjeTitle("matricula", "Krstna knjiga", "11")).toBe("#11 - Krstna knjiga");
    expect(pageObjeTitle("matricula", "Krstna knjiga", undefined)).toBe("Krstna knjiga");
    expect(pageObjeTitle(undefined, "Krstna knjiga", "11")).toBeUndefined();
  });
});
