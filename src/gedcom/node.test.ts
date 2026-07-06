import { describe, expect, it } from "vitest";
import type { GedNode } from "./types";
import {
  childrenByTag,
  childText,
  childValue,
  cloneNode,
  findByPath,
  firstChild,
  hasChild,
  removeChildren,
  upsertChild,
} from "./node";

function n(tag: string, value?: string, children: GedNode[] = [], level = 1): GedNode {
  return value !== undefined ? { level, tag, value, children } : { level, tag, children };
}

function indi(): GedNode {
  return n("INDI", undefined, [
    n("NAME", "John /Smith/"),
    n("NAME", "Johnny /Smith/"),
    n("SEX", "M"),
    n("BIRT", undefined, [n("DATE", "1900", [], 2), n("PLAC", "  Springfield  ", [], 2)]),
    n("NOTE", "   "),
  ], 0);
}

describe("firstChild / childrenByTag / hasChild", () => {
  it("finds the first matching child and all of them", () => {
    const i = indi();
    expect(firstChild(i, "NAME")?.value).toBe("John /Smith/");
    expect(childrenByTag(i, "NAME").map((c) => c.value)).toEqual(["John /Smith/", "Johnny /Smith/"]);
    expect(firstChild(i, "MARR")).toBeUndefined();
    expect(childrenByTag(i, "MARR")).toEqual([]);
  });

  it("matches any tag when given a list", () => {
    const i = indi();
    expect(firstChild(i, ["DEAT", "SEX", "NAME"])?.tag).toBe("NAME");
    expect(childrenByTag(i, ["SEX", "NOTE"]).map((c) => c.tag)).toEqual(["SEX", "NOTE"]);
  });

  it("is case-sensitive (does not fold tag case)", () => {
    const i = indi();
    expect(firstChild(i, "name")).toBeUndefined();
    expect(hasChild(i, "name")).toBe(false);
  });

  it("reports presence", () => {
    const i = indi();
    expect(hasChild(i, "SEX")).toBe(true);
    expect(hasChild(i, ["FAMC", "BIRT"])).toBe(true);
    expect(hasChild(i, "FAMC")).toBe(false);
  });
});

describe("childValue / childText", () => {
  it("childValue returns the raw (untrimmed) value", () => {
    const i = indi();
    expect(childValue(firstChild(i, "BIRT")!, "PLAC")).toBe("  Springfield  ");
    expect(childValue(i, "MARR")).toBeUndefined();
  });

  it("childText trims and collapses empty to undefined", () => {
    const i = indi();
    expect(childText(firstChild(i, "BIRT")!, "PLAC")).toBe("Springfield");
    expect(childText(i, "NOTE")).toBeUndefined(); // whitespace-only
    expect(childText(i, "SEX")).toBe("M");
  });
});

describe("findByPath", () => {
  it("walks a tag chain taking the first match at each step", () => {
    const i = indi();
    expect(findByPath(i, ["BIRT", "DATE"])?.value).toBe("1900");
    expect(findByPath(i, ["BIRT", "MARR"])).toBeUndefined();
    expect(findByPath(i, [])).toBe(i);
  });
});

describe("upsertChild", () => {
  it("creates a child at the right level when absent", () => {
    const i = indi();
    const sex = upsertChild(i, "FAMC", "@F1@");
    expect(sex).toEqual({ level: 1, tag: "FAMC", value: "@F1@", children: [] });
    expect(childValue(i, "FAMC")).toBe("@F1@");
  });

  it("returns the existing child without overwriting its value", () => {
    const i = indi();
    const before = firstChild(i, "SEX")!;
    const got = upsertChild(i, "SEX", "F");
    expect(got).toBe(before);
    expect(got.value).toBe("M"); // not overwritten
    expect(childrenByTag(i, "SEX")).toHaveLength(1);
  });
});

describe("removeChildren", () => {
  it("removes all matching children and returns the count", () => {
    const i = indi();
    expect(removeChildren(i, "NAME")).toBe(2);
    expect(hasChild(i, "NAME")).toBe(false);
    expect(removeChildren(i, "NAME")).toBe(0);
  });

  it("removes across a tag list", () => {
    const i = indi();
    expect(removeChildren(i, ["SEX", "NOTE"])).toBe(2);
    expect(i.children.map((c) => c.tag)).toEqual(["NAME", "NAME", "BIRT"]);
  });
});

describe("cloneNode", () => {
  it("deep-clones without aliasing", () => {
    const i = indi();
    const c = cloneNode(i);
    expect(c).toEqual(i);
    c.children[0].value = "changed";
    expect(firstChild(i, "NAME")?.value).toBe("John /Smith/");
  });

  it("preserves the auditStamp marker and verbatim lines", () => {
    // The merge stamps CHAN/CREA on a *clone* of the edit-marked main, so a
    // clone that dropped the marker would lose event-level audit stamps in a
    // combined edit+merge save.
    const i = indi();
    firstChild(i, "BIRT")!.auditStamp = "changed";
    i.children.push({ level: 1, tag: "", children: [], verbatim: "1GARBLED line" });
    const c = cloneNode(i);
    expect(firstChild(c, "BIRT")?.auditStamp).toBe("changed");
    expect(c.children.at(-1)?.verbatim).toBe("1GARBLED line");
  });
});
