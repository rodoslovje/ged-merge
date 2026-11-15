import { describe, expect, it } from "vitest";
import type { GedNode } from "./types";
import { detectPrivacyStyle, isPrivateNode, setPrivateFlag } from "./private";

function node(tag: string, value?: string, children: GedNode[] = []): GedNode {
  return { level: 1, tag, value, children };
}
function rec(children: GedNode[]): GedNode {
  return { level: 0, tag: "INDI", xref: "@I1@", children };
}

describe("isPrivateNode", () => {
  it("recognizes every dialect", () => {
    expect(isPrivateNode(rec([node("PRIV")]))).toBe(true); // MacFamilyTree, bare
    expect(isPrivateNode(rec([node("PRIV", "Y")]))).toBe(true);
    expect(isPrivateNode(rec([node("_PRIV", "Y")]))).toBe(true); // MyHeritage
    expect(isPrivateNode(rec([node("RESN", "privacy")]))).toBe(true);
    expect(isPrivateNode(rec([node("RESN", "CONFIDENTIAL")]))).toBe(true);
    expect(isPrivateNode(rec([node("RESN", "CONFIDENTIAL, LOCKED")]))).toBe(true); // 7.0 list
  });

  it("does not mistake non-privacy restrictions for private", () => {
    expect(isPrivateNode(rec([node("RESN", "NONE")]))).toBe(false); // webtrees noise
    expect(isPrivateNode(rec([node("RESN", "locked")]))).toBe(false); // edit-protection
    expect(isPrivateNode(rec([node("RESN", "NONE, LOCKED")]))).toBe(false);
    expect(isPrivateNode(rec([node("NOTE", "PRIV mentioned in text")]))).toBe(false);
  });
});

describe("detectPrivacyStyle", () => {
  it("follows the file's own dialect, standard RESN when there is none", () => {
    expect(detectPrivacyStyle([rec([node("PRIV")]), rec([node("PRIV")])])).toBe("PRIV");
    expect(detectPrivacyStyle([rec([node("_PRIV", "Y")])])).toBe("_PRIV");
    expect(detectPrivacyStyle([rec([node("RESN", "confidential")])])).toBe("RESN");
    expect(detectPrivacyStyle([rec([node("RESN", "NONE")])])).toBe("RESN"); // no markers at all
    expect(detectPrivacyStyle([rec([])])).toBe("RESN");
  });
});

describe("setPrivateFlag", () => {
  it("writes the file's dialect and clears all dialects", () => {
    const r = rec([node("NAME", "Ana /Novak/")]);
    setPrivateFlag(r, true, "PRIV", "5.5.1");
    expect(r.children.some((c) => c.tag === "PRIV" && c.value === undefined)).toBe(true);
    setPrivateFlag(r, false, "PRIV", "5.5.1");
    expect(isPrivateNode(r)).toBe(false);

    setPrivateFlag(r, true, "_PRIV", "5.5.1");
    expect(r.children.some((c) => c.tag === "_PRIV" && c.value === "Y")).toBe(true);
  });

  it("keeps non-privacy RESN list entries when clearing", () => {
    const r = rec([node("RESN", "CONFIDENTIAL, LOCKED")]);
    setPrivateFlag(r, false, "RESN", "5.5.1");
    expect(r.children.find((c) => c.tag === "RESN")?.value).toBe("LOCKED");
    expect(isPrivateNode(r)).toBe(false);
  });

  it("RESN casing follows the GEDCOM version", () => {
    const r = rec([]);
    setPrivateFlag(r, true, "RESN", "7.0");
    expect(r.children.find((c) => c.tag === "RESN")?.value).toBe("PRIVACY");
    const r2 = rec([]);
    setPrivateFlag(r2, true, "RESN", "5.5.1");
    expect(r2.children.find((c) => c.tag === "RESN")?.value).toBe("privacy");
  });
});
