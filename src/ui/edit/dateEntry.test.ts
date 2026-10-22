import { describe, expect, it } from "vitest";
import { inferDateProfile } from "../../normalize/profile";
import { parseDate } from "../../gedcom/date";
import { narrativeEn } from "../../report/lang/en";
import { narrativeSl } from "../../report/lang/sl";
import { previewDate } from "./dateEntry";

const style = { profile: inferDateProfile([]), order: "DMY" as const };

describe("previewDate", () => {
  it("reads a typed date in words and says what will be written", () => {
    expect(previewDate("~1850", style, "en")).toEqual({ kind: "ok", label: "about 1850", approx: true, saved: "ABT 1850" });
    expect(previewDate("5 MAR 1850", style, "en")).toEqual({ kind: "ok", label: "5 March 1850", approx: false });
  });

  it("offers the other reading of a numeric date whose day and month could swap", () => {
    const p = previewDate("5.6.1850", style, "en");
    expect(p).toMatchObject({ label: "5 June 1850", saved: "5 JUN 1850", swap: { label: "6 May 1850", saved: "6 MAY 1850" } });
    expect(previewDate("13.6.1850", style, "en")).not.toHaveProperty("swap");
    expect(previewDate("5.5.1850", style, "en")).not.toHaveProperty("swap");
    expect(previewDate("5 JUN 1850", style, "en")).not.toHaveProperty("swap");
  });

  it("warns of an impossible day and of text it cannot read", () => {
    expect(previewDate("31.2.1850", style, "en")).toMatchObject({ kind: "impossible" });
    expect(previewDate("pred vojno", style, "sl")).toEqual({ kind: "unreadable" });
  });
});

describe("dateLabel — a date standing alone", () => {
  it("writes English without the sentence's preposition", () => {
    expect(narrativeEn.dateLabel(parseDate("5 MAY 1848"))).toBe("5 May 1848");
    expect(narrativeEn.dateLabel(parseDate("1848"))).toBe("1848");
    expect(narrativeEn.dateLabel(parseDate("CAL 1848"))).toBe("about 1848 (calculated)");
    expect(narrativeEn.dateLabel(parseDate("BEF MAY 1848"))).toBe("before May 1848");
  });

  it("writes Slovenian the way a form does", () => {
    expect(narrativeSl.dateLabel(parseDate("5 MAY 1848"))).toBe("5. maja 1848");
    expect(narrativeSl.dateLabel(parseDate("MAY 1848"))).toBe("maj 1848");
    expect(narrativeSl.dateLabel(parseDate("1848"))).toBe("1848");
    expect(narrativeSl.dateLabel(parseDate("EST 1848"))).toBe("okoli leta 1848 (ocenjeno)");
    expect(narrativeSl.dateLabel(parseDate("BET 1848 AND 1850"))).toBe("med letoma 1848 in 1850");
  });
});
