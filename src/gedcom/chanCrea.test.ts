import { describe, expect, it } from "vitest";
import { markEventTouched } from "./edit";
import { nowGedcomTime, nowUpdStamp, stampChanCrea, todayGedcom } from "./chanCrea";
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

const ALL: ChanCreaUsage = { recordChan: true, recordCrea: true, eventChan: true, eventCrea: true, recordUpd: false };

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

/** MyHeritage's `_UPD` change stamp, the vendor equivalent of CHAN. */
describe("stampChanCrea — the _UPD change stamp", () => {
  const UPD = "24 JUN 2026 09:05:42 GMT +0200";
  const NONE: ChanCreaUsage = { recordChan: false, recordCrea: false, eventChan: false, eventCrea: false, recordUpd: false };
  const TAG_FORM: ChanCreaUsage = { ...NONE, recordUpd: "tag" };

  /** MyHeritage's older spelling: the timestamp on an EVEN typed `_UPD`. */
  function updEvent(value: string): GedNode {
    return { level: 1, tag: "EVEN", value, children: [{ level: 2, tag: "TYPE", value: "_UPD", children: [] }] };
  }

  it("refreshes an existing _UPD tag on a changed record", () => {
    const upd: GedNode = { level: 1, tag: "_UPD", value: "10 AUG 2026 01:57:49 GMT -0500", children: [] };
    const record = indi("@I1@", ev("BIRT", date("1 JAN 1900")), upd);

    stampChanCrea([record], new Set(["@I1@"]), new Set(), TAG_FORM, TODAY, NOW, UPD);

    expect(upd.value).toBe(UPD);
    // Exactly one stamp — the refresh must not leave a second beside it.
    expect(record.children.filter((c) => c.tag === "_UPD")).toHaveLength(1);
  });

  it("refreshes the event spelling in place rather than converting it", () => {
    const stamp = updEvent("31 JAN 2020 13:12:03 GMT -0500");
    const record = indi("@I1@", stamp);

    stampChanCrea([record], new Set(["@I1@"]), new Set(), { ...NONE, recordUpd: "event" }, TODAY, NOW, UPD);

    expect(stamp.value).toBe(UPD);
    expect(childTag(stamp, "TYPE")?.value).toBe("_UPD");
    expect(record.children.filter((c) => c.tag === "_UPD")).toHaveLength(0);
  });

  it("keeps a record's own spelling even when the file's is the other one", () => {
    const stamp = updEvent("31 JAN 2020 13:12:03 GMT -0500");
    const record = indi("@I1@", stamp);

    // File-level form is "tag" (the majority), this record's is the event.
    stampChanCrea([record], new Set(["@I1@"]), new Set(), TAG_FORM, TODAY, NOW, UPD);

    expect(stamp.value).toBe(UPD);
    expect(record.children.filter((c) => c.tag === "_UPD")).toHaveLength(0);
  });

  it("adds the file's form to a changed record that carries no stamp yet", () => {
    const record = indi("@I1@", ev("BIRT", date("1 JAN 1900")));

    stampChanCrea([record], new Set(["@I1@"]), new Set(), TAG_FORM, TODAY, NOW, UPD);

    expect(record.children.find((c) => c.tag === "_UPD")?.value).toBe(UPD);
  });

  it("leaves untouched records and non-_UPD files alone", () => {
    const untouched = indi("@I2@", { level: 1, tag: "_UPD", value: "10 AUG 2026 01:57:49 GMT -0500", children: [] });
    stampChanCrea([untouched], new Set(["@I1@"]), new Set(), TAG_FORM, TODAY, NOW, UPD);
    expect(untouched.children[0].value).toBe("10 AUG 2026 01:57:49 GMT -0500");

    const noConvention = indi("@I1@", ev("BIRT", date("1 JAN 1900")));
    stampChanCrea([noConvention], new Set(["@I1@"]), new Set(), NONE, TODAY, NOW, UPD);
    expect(noConvention.children.some((c) => c.tag === "_UPD")).toBe(false);
  });

  it("does not also stamp the _UPD event as an event", () => {
    const stamp = updEvent("31 JAN 2020 13:12:03 GMT -0500");
    const record = indi("@I9@", stamp);

    // A wholly new record stamps every event it has — except this one.
    stampChanCrea([record], new Set(["@I9@"]), new Set(["@I9@"]), { ...ALL, recordUpd: "event" }, TODAY, NOW, UPD);

    expect(childTag(stamp, "CHAN")).toBeUndefined();
    expect(childTag(stamp, "CREA")).toBeUndefined();
    expect(stamp.value).toBe(UPD);
  });

  it("writes the local zone offset in MyHeritage's shape", () => {
    const stamped = nowUpdStamp(new Date(2026, 5, 24, 9, 5, 42));
    expect(stamped).toMatch(/^24 JUN 2026 09:05:42 GMT [+-]\d{4}$/);
  });
});
