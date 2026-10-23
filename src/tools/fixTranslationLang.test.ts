import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { applyRecordPatches } from "../ui/historyTypes";
import { validateConformance } from "./conformance/conformance";
import { suggestLanguage, tagTranslations, UNDETERMINED, untaggedTranslations } from "./fixTranslationLang";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

// MacFamilyTree's shape: a place's historical names as a TRAN with no LANG.
const MFT = `0 HEAD
1 GEDC
2 VERS 7.0.3
0 @I1@ INDI
1 NAME Jurij /Mladič/
2 TRAN Georg /Mladitsch/
1 BIRT
2 PLAC Srednje Bitnje,Kranj
3 TRAN M.Feichting
3 MAP
4 LATI N46.2
4 LONG E14.3
1 DEAT
2 PLAC Hotemaže,Šenčur
3 TRAN M.Vellach, Media Wella
0 @I2@ INDI
1 NAME Ana /Kos/
1 BIRT
2 PLAC Srednje Bitnje,Kranj
3 TRAN M.Feichting
1 BURI
2 PLAC Kokra,Kranj
3 TRAN Kokriz
3 TRAN Gotteswald
4 LANG de
0 TRLR`;

const missingLang = (ds: ReturnType<typeof dataset>) =>
  validateConformance(ds).filter((i) => i.messageKey === "tools.validate.struct.issue.missing" && i.sample === "LANG");

describe("translations without a language", () => {
  it("suggests a language from a name's spelling", () => {
    expect(suggestLanguage("M.Feichting")).toBe("de");
    expect(suggestLanguage("Krainburg")).toBe("de");
    expect(suggestLanguage("Tschernembl")).toBe("de");
    expect(suggestLanguage("Media Wella")).toBe("la");
    expect(suggestLanguage("Inferiori Wella")).toBe("la");
    expect(suggestLanguage("Sv. Peter na Krasu")).toBe("sl");
    expect(suggestLanguage("Kokriz")).toBeUndefined();
  });

  it("groups the lines by value, splits a place's at its commas, and falls back to the file's habit", () => {
    const groups = untaggedTranslations(dataset(MFT));
    expect(groups.map((g) => [g.value, g.count, g.place, g.parts, g.suggested])).toEqual([
      ["M.Feichting", 2, true, ["M.Feichting"], ["de"]],
      ["Georg /Mladitsch/", 1, false, ["Georg /Mladitsch/"], ["de"]],
      ["Kokriz", 1, true, ["Kokriz"], ["de"]],
      ["M.Vellach, Media Wella", 1, true, ["M.Vellach", "Media Wella"], ["de", "la"]],
    ]);
  });

  it("writes LANG, splits parts of different languages into lines of their own, and undoes", () => {
    const ds = dataset(MFT);
    const original = serializeGedcom(ds.records);
    expect(missingLang(ds)).toHaveLength(5);
    const choices = new Map(untaggedTranslations(ds).map((g) => [g.key, g.suggested]));
    const patches = tagTranslations(ds, choices);
    expect(patches).toHaveLength(2);
    expect(missingLang(ds)).toHaveLength(0);
    const out = serializeGedcom(ds.records);
    expect(out).toContain("3 TRAN M.Feichting\n4 LANG de\n3 MAP\n");
    expect(out).toContain("3 TRAN M.Vellach\n4 LANG de\n3 TRAN Media Wella\n4 LANG la\n");
    expect(out).toContain("2 TRAN Georg /Mladitsch/\n3 LANG de\n");
    // The line that already had its language is untouched.
    expect(out).toContain("3 TRAN Gotteswald\n4 LANG de\n0 TRLR");
    applyRecordPatches(ds, patches, "undo");
    expect(serializeGedcom(ds.records)).toBe(original);
  });

  it("keeps parts of one language together, and settles only the chosen groups", () => {
    const ds = dataset(MFT);
    const groups = untaggedTranslations(ds);
    const vellach = groups.find((g) => g.value.startsWith("M.Vellach"))!;
    tagTranslations(ds, new Map([[vellach.key, [UNDETERMINED, UNDETERMINED]]]));
    const out = serializeGedcom(ds.records);
    expect(out).toContain("3 TRAN M.Vellach, Media Wella\n4 LANG und\n");
    expect(missingLang(ds)).toHaveLength(4);
  });

  it("finds nothing in a 5.5.1 file", () => {
    expect(untaggedTranslations(dataset(MFT.replace("2 VERS 7.0.3", "2 VERS 5.5.1")))).toEqual([]);
  });
});
