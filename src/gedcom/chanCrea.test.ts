import { describe, expect, it } from "vitest";
import { markEventTouched } from "./edit";
import { nowGedcomTime, stampChanCrea, todayGedcom } from "./chanCrea";
import type { ChanCreaUsage, GedNode } from "./types";

const TODAY = "24 JUN 2026";
const NOW = "09:05:42";

function ev(tag: string, ...children: GedNode[]): GedNode {
  return { level: 1, tag, children };
}

function indi(xref: string, ...children: GedNode[]): GedNode {
  return { level: 0, xref, tag: "INDI", children };
}

function date(value: string, ...children: GedNode[]): GedNode {
  return { level: 2, tag: "DATE", value, children };
}

const ALL: ChanCreaUsage = { recordChan: true, recordCrea: true, eventChan: true, eventCrea: true };

function childTag(node: GedNode | undefined, tag: string): GedNode | undefined {
  return node?.children.find((c) => c.tag === tag);
}

describe("stampChanCrea — event targeting", () => {
  it("stamps only the changed event, not an untouched sibling with its own CHAN", () => {
    const birt = ev("BIRT", date("1 JAN 1900"), ev("CHAN", date("1 JAN 2020")));
    const deat = ev("DEAT", date("1 JAN 1980"));
    markEventTouched(deat, "changed");
    const record = indi("@I1@", birt, deat);

    stampChanCrea([record], new Set(["@I1@"]), new Set(), ALL, TODAY, NOW);

    // Untouched BIRT keeps its old CHAN date.
    expect(childTag(childTag(birt, "CHAN"), "DATE")?.value).toBe("1 JAN 2020");
    // Touched DEAT gets a fresh CHAN.
    expect(childTag(childTag(deat, "CHAN"), "DATE")?.value).toBe(TODAY);
    // Marker is consumed.
    expect(deat.auditStamp).toBeUndefined();
  });

  it("adds CHAN+CREA to a newly added event on an existing record", () => {
    const deat = ev("DEAT", date("1 JAN 1980"));
    markEventTouched(deat, "new");
    const record = indi("@I1@", ev("BIRT", date("1 JAN 1900")), deat);

    stampChanCrea([record], new Set(["@I1@"]), new Set(), ALL, TODAY, NOW);

    expect(childTag(childTag(deat, "CHAN"), "DATE")?.value).toBe(TODAY);
    expect(childTag(childTag(deat, "CREA"), "DATE")?.value).toBe(TODAY);
  });

  it("refreshes a TIME subordinate only when one already exists", () => {
    const withTime = ev("CHR", date("1 JAN 1900"), ev("CHAN", date("1 JAN 2020", { level: 3, tag: "TIME", value: "00:00:00", children: [] })));
    markEventTouched(withTime, "changed");
    const record = indi("@I1@", withTime);

    stampChanCrea([record], new Set(["@I1@"]), new Set(), ALL, TODAY, NOW);

    const chanDate = childTag(childTag(withTime, "CHAN"), "DATE");
    expect(chanDate?.value).toBe(TODAY);
    expect(childTag(chanDate, "TIME")?.value).toBe(NOW);
  });

  it("stamps every event of a wholly new record without markers", () => {
    const birt = ev("BIRT", date("1 JAN 1900"));
    const record = indi("@I9@", birt);

    stampChanCrea([record], new Set(["@I9@"]), new Set(["@I9@"]), ALL, TODAY, NOW);

    expect(childTag(childTag(birt, "CHAN"), "DATE")?.value).toBe(TODAY);
    expect(childTag(childTag(birt, "CREA"), "DATE")?.value).toBe(TODAY);
  });

  it("formats date and time per GEDCOM conventions", () => {
    const d = new Date(2026, 5, 24, 9, 5, 42);
    expect(todayGedcom(d)).toBe("24 JUN 2026");
    expect(nowGedcomTime(d)).toBe("09:05:42");
  });
});
