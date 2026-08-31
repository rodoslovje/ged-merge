import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { displayName, primaryName } from "../match/relatives";
import type { Individual } from "../gedcom/types";
import {
  OWN_BRANCH,
  bloodDistance,
  bloodKin,
  buildKinBars,
  buildKinshipWheel,
  collectKin,
  WEDGE_LABEL_PX,
  generationOffset,
  kinDepth,
  lifeSpan,
  overlaps,
  type KinPerson,
} from "./kinshipWheel";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}
const nameOf = (indi: Individual) => displayName(primaryName(indi));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

// Root Janez (b. 1900) with: both parents, all four grandparents, a sister, a
// son and a grandson, a paternal uncle and his child (the root's first cousin),
// and a maternal aunt. Enough to exercise every ring, both sides and both
// directions. A fixed NOW keeps the presumed-living window reproducible.
const TREE = wrap(
  "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1900\n1 DEAT\n2 DATE 1970\n1 FAMC @F1@\n1 FAMS @F2@\n" +
    // parents
    "0 @I2@ INDI\n1 NAME Anton /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1870\n1 DEAT\n2 DATE 1940\n1 FAMC @F3@\n1 FAMS @F1@\n" +
    "0 @I3@ INDI\n1 NAME Marija /Kovac/\n1 SEX F\n1 BIRT\n2 DATE 1872\n1 DEAT\n2 DATE 1950\n1 FAMC @F4@\n1 FAMS @F1@\n" +
    // paternal grandparents
    "0 @I4@ INDI\n1 NAME Jakob /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1840\n1 DEAT\n2 DATE 1910\n1 FAMS @F3@\n" +
    "0 @I5@ INDI\n1 NAME Ana /Zajc/\n1 SEX F\n1 BIRT\n2 DATE 1845\n1 DEAT\n2 DATE 1915\n1 FAMS @F3@\n" +
    // maternal grandparents
    "0 @I6@ INDI\n1 NAME Peter /Kovac/\n1 SEX M\n1 BIRT\n2 DATE 1842\n1 DEAT\n2 DATE 1905\n1 FAMS @F4@\n" +
    "0 @I7@ INDI\n1 NAME Neza /Hribar/\n1 SEX F\n1 BIRT\n2 DATE 1848\n1 DEAT\n2 DATE 1920\n1 FAMS @F4@\n" +
    // sister, son, grandson
    "0 @I8@ INDI\n1 NAME Ana /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1898\n1 DEAT\n2 DATE 1975\n1 FAMC @F1@\n" +
    "0 @I9@ INDI\n1 NAME Peter /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1926\n1 DEAT\n2 DATE 1990\n1 FAMC @F2@\n1 FAMS @F5@\n" +
    "0 @I10@ INDI\n1 NAME Tone /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1955\n1 FAMC @F5@\n" +
    // paternal uncle + his child (first cousin)
    "0 @I11@ INDI\n1 NAME Lojze /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1874\n1 DEAT\n2 DATE 1930\n1 FAMC @F3@\n1 FAMS @F6@\n" +
    "0 @I12@ INDI\n1 NAME Vida /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1905\n1 DEAT\n2 DATE 1980\n1 FAMC @F6@\n" +
    // maternal aunt
    "0 @I13@ INDI\n1 NAME Micka /Kovac/\n1 SEX F\n1 BIRT\n2 DATE 1876\n1 DEAT\n2 DATE 1960\n1 FAMC @F4@\n" +
    // spouses, who are not blood kin
    "0 @I14@ INDI\n1 NAME Jera /Rak/\n1 SEX F\n1 BIRT\n2 DATE 1902\n1 DEAT\n2 DATE 1985\n1 FAMS @F2@\n" +
    "0 @F1@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n1 CHIL @I8@\n1 CHIL @I1@\n" +
    "0 @F2@ FAM\n1 HUSB @I1@\n1 WIFE @I14@\n1 CHIL @I9@\n" +
    "0 @F3@ FAM\n1 HUSB @I4@\n1 WIFE @I5@\n1 CHIL @I2@\n1 CHIL @I11@\n" +
    "0 @F4@ FAM\n1 HUSB @I6@\n1 WIFE @I7@\n1 CHIL @I3@\n1 CHIL @I13@\n" +
    "0 @F5@ FAM\n1 HUSB @I9@\n1 CHIL @I10@\n" +
    "0 @F6@ FAM\n1 HUSB @I11@\n1 CHIL @I12@\n",
);

const NOW = 2000;
const ds = dataset(TREE);
const input = { ds, rootId: "@I1@", nameOf, now: NOW };
const by = (people: KinPerson[], id: string) => {
  const p = people.find((x) => x.id === id);
  expect(p, `person ${id}`).toBeDefined();
  return p!;
};

describe("bloodKin", () => {
  const kin = bloodKin(ds, "@I1@");

  it("measures each relative as up-to-the-common-ancestor and back down", () => {
    expect(kin.get("@I1@")).toMatchObject({ up: 0, down: 0 });
    expect(kin.get("@I2@")).toMatchObject({ up: 1, down: 0 }); // father
    expect(kin.get("@I9@")).toMatchObject({ up: 0, down: 1 }); // son
    expect(kin.get("@I8@")).toMatchObject({ up: 1, down: 1 }); // sister
    expect(kin.get("@I4@")).toMatchObject({ up: 2, down: 0 }); // grandfather
    expect(kin.get("@I10@")).toMatchObject({ up: 0, down: 2 }); // grandson
    expect(kin.get("@I11@")).toMatchObject({ up: 2, down: 1 }); // uncle
    expect(kin.get("@I12@")).toMatchObject({ up: 2, down: 2 }); // first cousin
  });

  it("counts blood distance in birth links, not generations", () => {
    // The whole point of the radius: a sibling is *further* than a parent, and
    // a first cousin further than an uncle, though all sit near in generations.
    expect(bloodDistance(kin.get("@I2@")!)).toBe(1);
    expect(bloodDistance(kin.get("@I8@")!)).toBe(2);
    expect(bloodDistance(kin.get("@I11@")!)).toBe(3);
    expect(bloodDistance(kin.get("@I12@")!)).toBe(4);
  });

  it("signs the generation offset: elders positive, issue negative", () => {
    expect(generationOffset(kin.get("@I4@")!)).toBe(2); // grandfather
    expect(generationOffset(kin.get("@I8@")!)).toBe(0); // sister
    expect(generationOffset(kin.get("@I12@")!)).toBe(0); // first cousin
    expect(generationOffset(kin.get("@I10@")!)).toBe(-2); // grandson
  });

  it("leaves out relatives by marriage", () => {
    expect(kin.has("@I14@")).toBe(false); // the root's wife
  });

  it("is empty for a person the file does not hold", () => {
    expect(bloodKin(ds, "@NOPE@").size).toBe(0);
  });
});

describe("collectKin", () => {
  const people = collectKin(input);

  it("puts each relative on the side and grandparent line their blood runs through", () => {
    expect(by(people, "@I11@").side).toBe("father"); // paternal uncle
    expect(by(people, "@I11@").branch).toBe("@I4@"); // …through grandfather Jakob
    expect(by(people, "@I13@").side).toBe("mother"); // maternal aunt
    expect(by(people, "@I13@").branch).toBe("@I6@"); // …through grandfather Peter
    // Parents, siblings and issue descend from no single grandparent line.
    for (const id of ["@I2@", "@I3@", "@I8@", "@I9@", "@I10@"]) {
      expect(by(people, id).branch, id).toBe(OWN_BRANCH);
    }
  });

  it("keeps only those alive during the window when one is given", () => {
    // 1955–1970: the root's last years. The grandparents (all dead by 1920) go;
    // the grandson (b. 1955) and the sister (d. 1975) stay.
    const ids = collectKin({ ...input, window: { from: 1955, to: 1970 } }).map((p) => p.id);
    expect(ids).toContain("@I10@");
    expect(ids).toContain("@I8@");
    expect(ids).not.toContain("@I4@");
    expect(ids).not.toContain("@I6@");
  });

  it("keeps the root even when the window excludes their own lifespan", () => {
    const ids = collectKin({ ...input, window: { from: 1990, to: 2000 } }).map((p) => p.id);
    expect(ids).toContain("@I1@");
  });

  it("honours the blood-distance cap", () => {
    const ids = collectKin({ ...input, maxDistance: 2 }).map((p) => p.id);
    expect(ids).toContain("@I8@"); // sister, distance 2
    expect(ids).not.toContain("@I11@"); // uncle, distance 3
  });

  it("reports the depth the cap was measured against, not the capped depth", () => {
    // The Generations stepper counts "of N". Measuring the capped set would make
    // N equal the cap, so stepping down to 1 would hide the control that steps
    // back up — the chart would be stuck at its closest ring.
    expect(kinDepth(input)).toBe(4);
    expect(kinDepth({ ...input, maxDistance: 1 })).toBe(4);
    expect(kinDepth({ ...input, maxDistance: 2 })).toBe(4);
  });

  it("orders closest first", () => {
    expect(people.map((p) => p.distance)).toEqual([...people.map((p) => p.distance)].sort((a, b) => a - b));
  });
});

describe("lifeSpan", () => {
  it("closes an unrecorded death at the living window, not at today", () => {
    const grandfather = ds.individuals.get("@I4@")!;
    expect(lifeSpan(grandfather, ds, NOW)).toMatchObject({ from: 1840, to: 1910, openEnd: false });
    const grandson = ds.individuals.get("@I10@")!; // b. 1955, no death
    const span = lifeSpan(grandson, ds, NOW);
    expect(span).toMatchObject({ from: 1955, openEnd: true, living: true });
    expect(span.to).toBe(NOW);
  });

  it("overlaps only where the two stretches actually touch", () => {
    const span = { from: 1900, to: 1970, openEnd: false, living: false };
    expect(overlaps(span, 1960, 1980)).toBe(true);
    expect(overlaps(span, 1970, 1970)).toBe(true);
    expect(overlaps(span, 1971, 1990)).toBe(false);
    expect(overlaps(span, 1850, 1899)).toBe(false);
  });
});

describe("buildKinshipWheel", () => {
  const wheel = buildKinshipWheel(input);
  const dotOf = (id: string) => {
    const d = wheel.dots.find((x) => x.person.id === id);
    expect(d, `dot ${id}`).toBeDefined();
    return d!;
  };
  const dist = (id: string) => Math.hypot(dotOf(id).x - wheel.cx, dotOf(id).y - wheel.cy);

  it("draws every relative but the root, who is the centre", () => {
    expect(wheel.dots).toHaveLength(wheel.people.length - 1);
    expect(wheel.dots.some((d) => d.person.id === "@I1@")).toBe(false);
  });

  it("places closer blood nearer the centre", () => {
    expect(dist("@I2@")).toBeLessThan(dist("@I8@")); // father inside sister
    expect(dist("@I8@")).toBeLessThan(dist("@I11@")); // sister inside uncle
    expect(dist("@I11@")).toBeLessThan(dist("@I12@")); // uncle inside cousin
  });

  it("puts the father's blood on the left and the mother's on the right", () => {
    expect(dotOf("@I11@").x).toBeLessThan(wheel.cx); // paternal uncle
    expect(dotOf("@I13@").x).toBeGreaterThan(wheel.cx); // maternal aunt
  });

  it("stacks the grandfather's line above the grandmother's within a side", () => {
    const wedge = (id: string) => wheel.wedges.find((w) => w.ancestorId === id)!;
    // Angles run clockwise from −90 at 12 o'clock, so "above" is the smaller |a|.
    expect(Math.abs(wedge("@I4@").a0 + 90)).toBeLessThan(Math.abs(wedge("@I5@").a0 + 90));
    expect(Math.abs(wedge("@I6@").a0 + 90)).toBeLessThan(Math.abs(wedge("@I7@").a0 + 90));
  });

  it("keeps the root's own line in one wedge across the top", () => {
    const own = wheel.wedges.find((w) => w.key === OWN_BRANCH)!;
    expect(own.a0).toBeLessThan(-90);
    expect(own.a1).toBeGreaterThan(-90);
    // Parents, sister, son and grandson all live there.
    expect(own.count).toBe(5);
  });

  it("seats elders inside their issue when one ring holds both", () => {
    // Distance 1 is the parents *and* the son — the case that reads as noise
    // when a cell wraps them together.
    expect(dist("@I2@")).toBeLessThan(dist("@I9@"));
    expect(dist("@I3@")).toBeLessThan(dist("@I9@"));
  });

  it("labels a dot with the given name alone", () => {
    // A full name — worse, one carrying a married surname — crowds three
    // neighbours off the wheel for one person's benefit.
    const mother = wheel.labels.find((l) => l.person.id === "@I3@");
    expect(mother?.text).toBe("Marija");
    expect(wheel.labels.every((l) => !l.text.includes(" ") || l.text === l.person.given)).toBe(true);
  });

  it("names every relative within three birth links, crowded or not", () => {
    const named = new Set(wheel.labels.map((l) => l.person.id));
    const close = wheel.people.filter((p) => p.distance > 0 && p.distance <= 3);
    expect(close.length).toBeGreaterThan(0);
    for (const p of close) expect(named.has(p.id), `${p.name} (distance ${p.distance})`).toBe(true);
  });

  it("never lays a name over somebody else's dot", () => {
    // Worse than a missing name: a name sitting on the wrong mark reads as
    // though that dot is the person it names.
    for (const l of wheel.labels) {
      const w = l.text.length * 10.5 * 0.55;
      const x0 = l.anchor === "end" ? l.x - w : l.x;
      const box = { x0, x1: x0 + w, y0: l.y - 9, y1: l.y + 3 };
      if (l.person.distance <= 3) continue; // may cross a mark rather than go unnamed
      for (const d of wheel.dots) {
        if (d.person.id === l.person.id) continue;
        const dot = { x0: d.x - d.r, x1: d.x + d.r, y0: d.y - d.r, y1: d.y + d.r };
        const clash = box.x0 < dot.x1 && box.x1 > dot.x0 && box.y0 < dot.y1 && box.y1 > dot.y0;
        expect(clash, `${l.text} over ${d.person.name}`).toBe(false);
      }
    }
  });

  it("names close kin without overlapping any two labels", () => {
    expect(wheel.labels.length).toBeGreaterThan(0);
    const boxes = wheel.labels.map((l) => {
      const w = l.text.length * 10.5 * 0.55;
      const x0 = l.anchor === "end" ? l.x - w : l.x;
      return { x0, x1: x0 + w, y0: l.y - 9, y1: l.y + 3 };
    });
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const clash = a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
        expect(clash, `${wheel.labels[i].text} vs ${wheel.labels[j].text}`).toBe(false);
      }
    }
  });

  it("pads the canvas so a long wedge caption is not cut off", () => {
    // A grandparent with three given names pushed the caption — and its count —
    // past a fixed margin and off the edge of the chart.
    const longNames = dataset(TREE.replace("Jakob /Novak/", "Branko Anton Bubinec /Novak/"));
    const chart = buildKinshipWheel({ ds: longNames, rootId: "@I1@", nameOf, now: NOW });
    const wedge = chart.wedges.find((w) => w.ancestorId === "@I4@")!;
    const width = ("Branko Anton Bubinec Novak".length + 5) * WEDGE_LABEL_PX * 0.55;
    const right = wedge.labelAnchor === "start" ? wedge.labelX + width : wedge.labelX;
    const left = wedge.labelAnchor === "end" ? wedge.labelX - width : wedge.labelX;
    expect(left).toBeGreaterThan(0);
    expect(right).toBeLessThan(chart.width);
  });

  it("lists a ring for every blood distance in reach", () => {
    expect(wheel.maxDistance).toBe(4);
    expect(wheel.rings.map((r) => r.distance)).toEqual([1, 2, 3, 4]);
    expect(wheel.rings.find((r) => r.distance === 1)!.count).toBe(3); // 2 parents + son
  });

  it("survives a root with no relatives at all", () => {
    const lone = dataset(wrap("0 @I1@ INDI\n1 NAME Sam /Alone/\n1 SEX M\n1 BIRT\n2 DATE 1900\n"));
    const chart = buildKinshipWheel({ ds: lone, rootId: "@I1@", nameOf, now: NOW });
    expect(chart.dots).toHaveLength(0);
    expect(chart.width).toBeGreaterThan(0);
  });
});

describe("buildKinBars", () => {
  const bars = buildKinBars({ ...input, width: 1200 });

  it("bands the rows by blood distance, the root first", () => {
    expect(bars.bands.map((b) => b.distance)).toEqual([0, 1, 2, 3, 4]);
    expect(bars.bands[0].rows.map((r) => r.person.id)).toEqual(["@I1@"]);
  });

  it("gives the close rings room for a name and the far ones a hairline", () => {
    const h = (d: number) => bars.bands.find((b) => b.distance === d)!.rowH;
    expect(h(1)).toBeGreaterThan(h(4));
    expect(bars.bands.find((b) => b.distance === 1)!.rows[0].named).toBe(true);
  });

  it("holds the root's band in the sticky header", () => {
    expect(bars.headerHeight).toBeGreaterThan(bars.bands[0].y);
    expect(bars.headerHeight).toBeLessThan(bars.bands[1].y + bars.bands[1].rowH);
  });

  it("leaves the earliest named person room for their name in the margin", () => {
    const named = bars.bands.flatMap((b) => b.rows).filter((r) => r.named);
    const earliest = Math.min(...named.map((r) => r.x0));
    expect(earliest).toBeGreaterThan(168); // BAR_LEFT — the axis gutter
  });

  it("runs the axis to the present for someone still living", () => {
    expect(bars.maxYear).toBeGreaterThanOrEqual(NOW);
    const grandson = bars.bands.flatMap((b) => b.rows).find((r) => r.person.id === "@I10@")!;
    expect(grandson.x1).toBeCloseTo(bars.xOf(NOW), 0);
  });
});
