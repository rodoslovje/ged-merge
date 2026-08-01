import { describe, expect, it } from "vitest";
import { parseGedcom } from "../../gedcom/parser";
import { buildDataset } from "../../gedcom/builder";
import { childText, firstChild } from "../../gedcom/node";
import { repoRecordEditFields, setRepoRecordFields, setSourceRecordFields, sourceRecordEditFields } from "../../gedcom/edit";
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

describe("createStandaloneSource repository choice", () => {
  const WITH_REPO = [
    "0 HEAD",
    "1 GEDC",
    "2 VERS 5.5.1",
    "0 @R1@ REPO",
    "1 NAME Nadškofijski arhiv Ljubljana",
    "0 TRLR",
    "",
  ].join("\n");

  it("links the chosen existing repository", () => {
    const ds = buildFromText(WITH_REPO);
    const { sourceXref } = createStandaloneSource(
      ds.records,
      { title: "Krstna knjiga", repoXref: "@R1@" },
      { sourceLayout: "auto" },
    );
    const source = ds.records.find((r) => r.xref === sourceXref)!;
    expect(firstChild(source, "REPO")?.value).toBe("@R1@");
    expect(ds.records.filter((r) => r.tag === "REPO")).toHaveLength(1);
  });

  it("creates the recognized site's repository on demand", () => {
    const ds = buildFromText(WITH_REPO);
    const { sourceXref, extraPatches } = createStandaloneSource(
      ds.records,
      { title: "Seznam ulic", url: "https://www.dlib.si/details/URN:NBN:SI:DOC-X", site: "dlib", repoCreateSite: true },
      { sourceLayout: "auto" },
    );
    const source = ds.records.find((r) => r.xref === sourceXref)!;
    const repo = ds.records.find((r) => r.tag === "REPO" && childText(r, "NAME")?.startsWith("dLib.si"))!;
    expect(firstChild(source, "REPO")?.value).toBe(repo.xref);
    expect(extraPatches.some((p) => p.id === repo.xref && p.before === null)).toBe(true);
  });

  it("creates a hand-named repository and links the new source to it", () => {
    const ds = buildFromText(WITH_REPO);
    const { sourceXref, extraPatches } = createStandaloneSource(
      ds.records,
      { title: "Družinski arhiv", repoCreateName: "Župnijski arhiv Šenčur", repoCaln: "K 3" },
      { sourceLayout: "auto" },
    );
    const source = ds.records.find((r) => r.xref === sourceXref)!;
    const repo = ds.records.find((r) => r.tag === "REPO" && childText(r, "NAME") === "Župnijski arhiv Šenčur")!;
    expect(firstChild(source, "REPO")?.value).toBe(repo.xref);
    expect(firstChild(firstChild(source, "REPO")!, "CALN")?.value).toBe("K 3");
    expect(extraPatches.some((p) => p.id === repo.xref && p.before === null)).toBe(true);
  });

  it("an explicit no-repository choice suppresses the automatic site repo", () => {
    const ds = buildFromText(WITH_REPO);
    const { sourceXref } = createStandaloneSource(
      ds.records,
      { title: "Seznam ulic", url: "https://www.dlib.si/details/URN:NBN:SI:DOC-X", site: "dlib", repoXref: "" },
      { sourceLayout: "repository" },
    );
    const source = ds.records.find((r) => r.xref === sourceXref)!;
    expect(firstChild(source, "REPO")).toBeUndefined();
    expect(ds.records.filter((r) => r.tag === "REPO")).toHaveLength(1); // only the pre-existing one
  });
});

describe("pageObjeTitle", () => {
  it("titles a recognized site's page image as `#page - title`", () => {
    expect(pageObjeTitle("matricula", "Krstna knjiga", "11")).toBe("#11 - Krstna knjiga");
    expect(pageObjeTitle("matricula", "Krstna knjiga", undefined)).toBe("Krstna knjiga");
    expect(pageObjeTitle(undefined, "Krstna knjiga", "11")).toBeUndefined();
  });
});

describe("repoXref on setSourceRecordFields / setRepoRecordFields", () => {
  it("sets, prefills and clears the source's REPO link", () => {
    const ds = buildFromText(BASE);
    const { sourceXref } = createStandaloneSource(ds.records, { title: "X" }, { sourceLayout: "auto" });
    const source = ds.records.find((r) => r.xref === sourceXref)!;
    ds.records.push({ level: 0, xref: "@R9@", tag: "REPO", children: [{ level: 1, tag: "NAME", value: "Arhiv", children: [] }] });

    setSourceRecordFields(ds.records, source, { repoXref: "@R9@" });
    expect(firstChild(source, "REPO")?.value).toBe("@R9@");
    expect(sourceRecordEditFields(ds.records, source).repoXref).toBe("@R9@");

    setSourceRecordFields(ds.records, source, { repoXref: "" });
    expect(firstChild(source, "REPO")).toBeUndefined();
    expect(sourceRecordEditFields(ds.records, source).repoXref).toBe("");
  });

  it("repoCreateName creates the repository and re-points the source's link", () => {
    const ds = buildFromText(BASE);
    const { sourceXref } = createStandaloneSource(ds.records, { title: "X", repoXref: "@R9@" }, { sourceLayout: "auto" });
    const source = ds.records.find((r) => r.xref === sourceXref)!;
    ds.records.push({ level: 0, xref: "@R9@", tag: "REPO", children: [{ level: 1, tag: "NAME", value: "Arhiv", children: [] }] });

    setSourceRecordFields(ds.records, source, { repoCreateName: "Občinski arhiv Kranj" });
    const repo = ds.records.find((r) => r.tag === "REPO" && childText(r, "NAME") === "Občinski arhiv Kranj")!;
    expect(repo).toBeDefined();
    expect(firstChild(source, "REPO")?.value).toBe(repo.xref);
  });

  it("edits a repository's fields — NAME first, multi-line address, clear removes lines", () => {
    const ds = buildFromText(BASE);
    const repo = { level: 0, xref: "@R1@", tag: "REPO", children: [{ level: 1, tag: "NAME", value: "Staro ime", children: [] }] };
    ds.records.push(repo);

    setRepoRecordFields(repo, {
      name: "Nadškofijski arhiv",
      addr: "Krekov trg 1\n1000 Ljubljana",
      phone: "01 234 56 78",
      email: "arhiv@rkc.si",
      url: "https://nadskofija-ljubljana.si/arhiv/",
      note: "Odprt ob sredah.",
    });
    expect(repo.children[0]).toMatchObject({ tag: "NAME", value: "Nadškofijski arhiv" });
    const addr = repo.children.find((c) => c.tag === "ADDR")!;
    expect(addr.value).toBe("Krekov trg 1");
    expect(addr.children[0]).toMatchObject({ tag: "CONT", value: "1000 Ljubljana" });
    expect(repo.children.map((c) => c.tag)).toEqual(["NAME", "ADDR", "PHON", "EMAIL", "WWW", "NOTE"]);

    const fields = repoRecordEditFields(ds.records, repo);
    expect(fields.addr).toBe("Krekov trg 1\n1000 Ljubljana");
    expect(fields.email).toBe("arhiv@rkc.si");

    // "" clears a line; undefined leaves it untouched.
    setRepoRecordFields(repo, { url: "", addr: "" });
    expect(repo.children.some((c) => c.tag === "WWW" || c.tag === "ADDR")).toBe(false);
    expect(repo.children.some((c) => c.tag === "PHON")).toBe(true);
  });

  it("writes and clears the CALN call number on the source's REPO link", () => {
    const ds = buildFromText(BASE);
    const { sourceXref } = createStandaloneSource(
      ds.records,
      { title: "Krstna knjiga", repoXref: "@R1@", repoCaln: "ŽA Šenčur, K 3" },
      { sourceLayout: "auto" },
    );
    const source = ds.records.find((r) => r.xref === sourceXref)!;
    const repoLink = firstChild(source, "REPO")!;
    expect(firstChild(repoLink, "CALN")?.value).toBe("ŽA Šenčur, K 3");
    expect(sourceRecordEditFields(ds.records, source).repoCaln).toBe("ŽA Šenčur, K 3");

    setSourceRecordFields(ds.records, source, { repoXref: "@R1@", repoCaln: "" });
    expect(firstChild(repoLink, "CALN")).toBeUndefined();
  });
});
