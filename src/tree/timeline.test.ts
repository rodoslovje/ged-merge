import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { displayName, primaryName } from "../match/relatives";
import type { Individual } from "../gedcom/types";
import { buildTimeline, type TimelineRow } from "./timeline";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

/** Identity translator: tests assert on keys, not localized labels. */
const tr = (key: string) => key;
const nameOf = (indi: Individual) => displayName(primaryName(indi));

const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

// Root Janez (1900–1970, married 1925) with parents (father 1870–1940, mother
// 1872), an older and a younger sibling, a wife (1902) and two children — the
// younger child's birth is undated. The father remarried (1935): a step-mother
// and a half-brother (1936). The wife brought a daughter (1922) from an
// earlier union: the root's step-daughter.
const FAMILY = wrap(
  "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1900\n2 PLAC Kranj\n" +
    "1 OCCU Farmer\n2 DATE 1930\n1 DEAT\n2 DATE 1970\n1 FAMC @F1@\n1 FAMS @F2@\n" +
    "0 @I2@ INDI\n1 NAME Anton /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1870\n1 DEAT\n2 DATE 1940\n1 FAMS @F1@\n1 FAMS @F3@\n" +
    "0 @I3@ INDI\n1 NAME Marija /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1872\n1 FAMS @F1@\n" +
    "0 @I4@ INDI\n1 NAME Ana /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1898\n1 FAMC @F1@\n" +
    "0 @I5@ INDI\n1 NAME Franc /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1903\n1 FAMC @F1@\n" +
    "0 @I6@ INDI\n1 NAME Neza /Kovac/\n1 SEX F\n1 BIRT\n2 DATE 1902\n1 FAMS @F2@\n1 FAMS @F4@\n" +
    "0 @I7@ INDI\n1 NAME Peter /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1926\n1 FAMC @F2@\n" +
    "0 @I8@ INDI\n1 NAME Ivana /Novak/\n1 SEX F\n1 FAMC @F2@\n" +
    "0 @I9@ INDI\n1 NAME Micka /Zajc/\n1 SEX F\n1 BIRT\n2 DATE 1905\n1 FAMS @F3@\n" +
    "0 @I10@ INDI\n1 NAME Tone /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1936\n1 FAMC @F3@\n" +
    "0 @I11@ INDI\n1 NAME Vida /Kovac/\n1 SEX F\n1 BIRT\n2 DATE 1922\n1 FAMC @F4@\n" +
    "0 @F1@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n1 CHIL @I4@\n1 CHIL @I1@\n1 CHIL @I5@\n" +
    "1 MARR\n2 DATE 1895\n" +
    "0 @F2@ FAM\n1 HUSB @I1@\n1 WIFE @I6@\n1 CHIL @I7@\n1 CHIL @I8@\n" +
    "1 MARR\n2 DATE 1925\n2 PLAC Kranj\n" +
    "0 @F3@ FAM\n1 HUSB @I2@\n1 WIFE @I9@\n1 CHIL @I10@\n1 MARR\n2 DATE 1935\n" +
    "0 @F4@ FAM\n1 WIFE @I6@\n1 CHIL @I11@\n",
);

// A fixed "today" for reproducibility, chosen so the wife (b. 1902) and son
// (b. 1926) fall inside the 100-year presumed-living window but the mother
// (b. 1872) does not.
const NOW = 2000;

function row(rows: TimelineRow[], id: string): TimelineRow {
  const r = rows.find((x) => x.id === id);
  expect(r, `row ${id}`).toBeDefined();
  return r!;
}

describe("buildTimeline", () => {
  const ds = dataset(FAMILY);
  const data = buildTimeline(tr, ds, "@I1@", nameOf, NOW)!;

  it("orders rows: parents, step-parents, generation by birth, spouse, children", () => {
    expect(data.rows.map((r) => r.id)).toEqual([
      "@I2@", // father
      "@I3@", // mother
      "@I9@", // step-mother (father's second wife)
      "@I4@", // older sister (1898)
      "@I1@", // root (1900)
      "@I5@", // younger brother (1903)
      "@I10@", // half-brother (1936), interleaved by birth
      "@I6@", // wife
      "@I11@", // her daughter from an earlier union (1922) — step-daughter
      "@I7@", // son (1926)
      "@I8@", // undated daughter
    ]);
    expect(data.rows.map((r) => r.role)).toEqual([
      "parent", "parent", "stepparent", "sibling", "person", "sibling", "halfsibling", "spouse", "stepchild", "child", "child",
    ]);
  });

  it("spans the axis over every bar and mark", () => {
    expect(data.minYear).toBe(1870);
    expect(data.maxYear).toBe(NOW); // the presumed-living wife's bar runs to today
  });

  it("draws a closed bar for a person with both years", () => {
    const root = row(data.rows, "@I1@");
    expect(root).toMatchObject({ from: 1900, to: 1970, openStart: false, openEnd: false, years: "1900–1970" });
  });

  it("runs an open-ended bar to today for a presumed-living person", () => {
    const wife = row(data.rows, "@I6@");
    expect(wife).toMatchObject({ from: 1902, to: NOW, openEnd: true, living: true });
  });

  it("stops an undatable-death bar at the last dated event", () => {
    // Mother born 1872, no death event, born >100y ago → not living; her only
    // dated marks are her birth and the 1895 marriage.
    const mother = row(data.rows, "@I3@");
    expect(mother).toMatchObject({ from: 1872, to: 1895, openEnd: true, living: false });
  });

  it("leaves an undated person without a bar", () => {
    const daughter = row(data.rows, "@I8@");
    expect(daughter.from).toBeUndefined();
    expect(daughter.to).toBeUndefined();
  });

  it("marks the root's dated events and marriage", () => {
    const root = row(data.rows, "@I1@");
    const years = root.marks.map((m) => `${m.kind}:${m.year}`);
    expect(years).toEqual(["event:1900", "marriage:1925", "event:1930", "event:1970"]);
    expect(root.marks[0].label).toContain("event.BIRT");
    expect(root.marks[0].label).toContain("Kranj");
    expect(root.marks[1].label).toContain("event.MARR");
  });

  it("gives every row its own event marks (the UI picks whose to show)", () => {
    const father = row(data.rows, "@I2@");
    expect(father.marks.map((m) => `${m.kind}:${m.year}`)).toEqual([
      "event:1870", "marriage:1895", "marriage:1935", "event:1940",
    ]);
  });

  it("marks every marriage on the spouse, parent and step-parent rows", () => {
    const marriageYears = (id: string) =>
      row(data.rows, id).marks.filter((m) => m.kind === "marriage").map((m) => m.year);
    expect(marriageYears("@I6@")).toEqual([1925]);
    expect(marriageYears("@I2@")).toEqual([1895, 1935]); // both of the father's unions
    expect(marriageYears("@I9@")).toEqual([1935]); // the step-mother's own union
    expect(marriageYears("@I3@")).toEqual([1895]); // the mother only hers
  });

  it("writes compact lane labels leading with the event's own detail", () => {
    const root = row(data.rows, "@I1@");
    const shorts = root.marks.filter((m) => m.kind === "event").map((m) => m.short);
    // Birth: no value → locality; occupation: its value; death: bare tag label.
    expect(shorts).toEqual(["Kranj 1900", "Farmer 1930", "event.DEAT 1970"]);
  });

  it("assigns genealogy glyphs to typed events, none to the rest", () => {
    const root = row(data.rows, "@I1@");
    const glyphs = root.marks.filter((m) => m.kind === "event").map((m) => m.glyph);
    // Birth *, occupation has no conventional symbol (generic dot), death †.
    expect(glyphs).toEqual(["*", undefined, "†"]);
  });

  it("returns undefined for an unknown root", () => {
    expect(buildTimeline(tr, ds, "@NOPE@", nameOf, NOW)).toBeUndefined();
  });

  it("handles a root with no relatives", () => {
    const solo = dataset(wrap("0 @I1@ INDI\n1 NAME Solo /One/\n1 BIRT\n2 DATE 1950\n"));
    const d = buildTimeline(tr, solo, "@I1@", nameOf, NOW)!;
    expect(d.rows).toHaveLength(1);
    expect(d.rows[0]).toMatchObject({ role: "person", from: 1950, to: NOW, openEnd: true });
  });

  it("builds residence periods: explicit range, else to the next, else to the bar end", () => {
    const solo = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Solo /One/\n1 BIRT\n2 DATE 1900\n1 DEAT\n2 DATE 1990\n" +
        "1 RESI\n2 DATE FROM 1920 TO 1930\n2 PLAC Kranj\n" +
        "1 RESI\n2 DATE 1950\n2 PLAC Ljubljana\n2 ADDR Dunajska 5\n" +
        "1 RESI\n2 DATE 1970\n2 PLAC Maribor\n",
    ));
    const d = buildTimeline(tr, solo, "@I1@", nameOf, NOW)!;
    expect(d.rows[0].residences).toEqual([
      // Explicit FROM..TO range keeps its own end — the 1930–1950 gap stays a gap.
      expect.objectContaining({ from: 1920, to: 1930, place: "Kranj" }),
      // A point-dated residence runs to the next one; a recorded street address
      // (house number kept) beats the place's locality for display.
      expect.objectContaining({ from: 1950, to: 1970, place: "Dunajska 5" }),
      // …and the last one runs to the end of the person's bar.
      expect.objectContaining({ from: 1970, to: 1990, place: "Maribor" }),
    ]);
  });

  it("leaves residences empty when no RESI is dated", () => {
    expect(row(data.rows, "@I1@").residences).toEqual([]);
  });
});
