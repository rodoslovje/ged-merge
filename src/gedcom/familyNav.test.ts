import { describe, expect, it } from "vitest";
import { buildDataset } from "./builder";
import { parseGedcom } from "./parser";
import { familyStepTarget } from "./familyNav";
import { familyStepFor } from "../keyboard/shortcuts";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

// Ana (I1) is a middle child of F1 (Janez × Marija), with an elder brother Ivan
// and a younger sister Mira; the file lists the children out of birth order.
// After Marija's death Janez had a second family F2, so Ana also has a
// half-brother Lojze (born 1900, i.e. after all of F1's children).
// Ana herself married twice: F3 (⚭ 1898, children Tone 1899 and Vida 1901) and
// F4 (⚭ 1910, no children).
const TREE = wrap(
  "0 @I1@ INDI\n1 NAME Ana /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1875\n1 FAMC @F1@\n1 FAMS @F3@\n1 FAMS @F4@\n" +
    "0 @I2@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n1 FAMS @F2@\n" +
    "0 @I3@ INDI\n1 NAME Marija /Novak/\n1 SEX F\n1 FAMS @F1@\n" +
    "0 @I4@ INDI\n1 NAME Ivan /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1870\n1 FAMC @F1@\n" +
    "0 @I5@ INDI\n1 NAME Mira /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1880\n1 FAMC @F1@\n" +
    "0 @I6@ INDI\n1 NAME Lojze /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1900\n1 FAMC @F2@\n" +
    "0 @I7@ INDI\n1 NAME Franc /Kovac/\n1 SEX M\n1 FAMS @F3@\n" +
    "0 @I8@ INDI\n1 NAME Peter /Oblak/\n1 SEX M\n1 FAMS @F4@\n" +
    "0 @I9@ INDI\n1 NAME Tone /Kovac/\n1 SEX M\n1 BIRT\n2 DATE 1899\n1 FAMC @F3@\n" +
    "0 @I10@ INDI\n1 NAME Vida /Kovac/\n1 SEX F\n1 BIRT\n2 DATE 1901\n1 FAMC @F3@\n" +
    "0 @I11@ INDI\n1 NAME Neza /Zupan/\n1 SEX F\n1 FAMS @F2@\n" +
    "0 @F1@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n1 CHIL @I5@\n1 CHIL @I1@\n1 CHIL @I4@\n" +
    "0 @F2@ FAM\n1 HUSB @I2@\n1 WIFE @I11@\n1 CHIL @I6@\n" +
    "0 @F3@ FAM\n1 HUSB @I7@\n1 WIFE @I1@\n1 MARR\n2 DATE 1898\n1 CHIL @I10@\n1 CHIL @I9@\n" +
    "0 @F4@ FAM\n1 HUSB @I8@\n1 WIFE @I1@\n1 MARR\n2 DATE 1910\n",
);

describe("familyStepTarget", () => {
  const ds = dataset(TREE);

  it("steps up to each parent", () => {
    expect(familyStepTarget(ds, "@I1@", "father")).toBe("@I2@");
    expect(familyStepTarget(ds, "@I1@", "mother")).toBe("@I3@");
  });

  it("reaches the one recorded parent from either step", () => {
    const single = dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME Ana //\n1 FAMC @F1@\n" +
          "0 @I2@ INDI\n1 NAME Marija //\n1 SEX F\n1 FAMS @F1@\n" +
          "0 @F1@ FAM\n1 WIFE @I2@\n1 CHIL @I1@\n",
      ),
    );
    expect(familyStepTarget(single, "@I1@", "father")).toBe("@I2@");
    expect(familyStepTarget(single, "@I1@", "mother")).toBe("@I2@");
  });

  it("has nowhere to go without parents", () => {
    expect(familyStepTarget(ds, "@I2@", "father")).toBeUndefined();
    expect(familyStepTarget(ds, "@I2@", "mother")).toBeUndefined();
  });

  it("walks the siblings by birth, not by file order", () => {
    expect(familyStepTarget(ds, "@I1@", "prevSibling")).toBe("@I4@"); // Ivan 1870
    expect(familyStepTarget(ds, "@I1@", "nextSibling")).toBe("@I5@"); // Mira 1880
  });

  it("stops at the ends of the sibling run", () => {
    expect(familyStepTarget(ds, "@I4@", "prevSibling")).toBeUndefined();
    expect(familyStepTarget(ds, "@I5@", "nextSibling")).toBeUndefined();
  });

  it("counts half-siblings, in the parent family's own order", () => {
    // Lojze is F2's only child, so from him the step back reaches F2 alone.
    expect(familyStepTarget(ds, "@I6@", "prevSibling")).toBeUndefined();
    // Janez's children through both families, seen from Ivan of F1.
    expect(familyStepTarget(ds, "@I4@", "nextSibling")).toBe("@I1@");
  });

  it("steps down to the eldest and the youngest child", () => {
    expect(familyStepTarget(ds, "@I1@", "firstChild")).toBe("@I9@"); // Tone 1899
    expect(familyStepTarget(ds, "@I1@", "lastChild")).toBe("@I10@"); // Vida 1901
  });

  it("skips a childless union when stepping down", () => {
    // F4 (⚭ 1910) is Ana's later, childless union — the step finds F3's children.
    expect(familyStepTarget(ds, "@I8@", "firstChild")).toBeUndefined();
    expect(familyStepTarget(ds, "@I9@", "firstChild")).toBeUndefined();
  });

  it("toggles between the two spouses of a single union", () => {
    // Franc's only partner is Ana, so the step lands on her whether or not he
    // was opened from her — pressed twice it comes straight back.
    expect(familyStepTarget(ds, "@I7@", "nextPartner")).toBe("@I1@");
    expect(familyStepTarget(ds, "@I7@", "nextPartner", "@I1@")).toBe("@I1@");
    expect(familyStepTarget(ds, "@I7@", "prevPartner", "@I1@")).toBe("@I1@");
  });

  it("tours several partners, positioned by the person come from", () => {
    // Ana's unions in marriage order: Franc (1898), Peter (1910).
    expect(familyStepTarget(ds, "@I1@", "nextPartner")).toBe("@I7@");
    expect(familyStepTarget(ds, "@I1@", "nextPartner", "@I7@")).toBe("@I8@");
    expect(familyStepTarget(ds, "@I1@", "nextPartner", "@I8@")).toBe("@I7@");
    expect(familyStepTarget(ds, "@I1@", "prevPartner")).toBe("@I8@");
    expect(familyStepTarget(ds, "@I1@", "prevPartner", "@I7@")).toBe("@I8@");
  });

  it("has no partner step for someone in no union", () => {
    expect(familyStepTarget(ds, "@I4@", "nextPartner")).toBeUndefined();
  });

  it("ignores an unknown person", () => {
    expect(familyStepTarget(ds, "@I99@", "father")).toBeUndefined();
  });
});

describe("familyStepFor", () => {
  it("maps the arrows to the axes of the layout", () => {
    expect(familyStepFor("ArrowUp", false)).toBe("father");
    expect(familyStepFor("ArrowDown", false)).toBe("firstChild");
    expect(familyStepFor("ArrowLeft", false)).toBe("prevSibling");
    expect(familyStepFor("ArrowRight", false)).toBe("nextSibling");
  });

  it("takes the other one on the axis with Shift", () => {
    expect(familyStepFor("ArrowUp", true)).toBe("mother");
    expect(familyStepFor("ArrowDown", true)).toBe("lastChild");
    expect(familyStepFor("ArrowLeft", true)).toBe("prevPartner");
    expect(familyStepFor("ArrowRight", true)).toBe("nextPartner");
  });

  it("leaves every other key alone", () => {
    expect(familyStepFor("a", false)).toBeUndefined();
    expect(familyStepFor("Enter", true)).toBeUndefined();
  });
});
