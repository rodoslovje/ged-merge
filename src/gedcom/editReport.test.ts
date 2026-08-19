import { describe, expect, it } from "vitest";
import { buildDataset } from "./builder";
import { parseGedcom } from "./parser";
import type { ChangeReport } from "../merge/merge";
import { buildEditReport, combineReports, enrichEditReport, removeRecordFromReport } from "./editReport";
import { cloneNode } from "./node";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}
const tr = (key: string) => key;
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

function baseReport(id: string): ChangeReport {
  return {
    changes: [],
    deferred: [],
    graftJoins: [],
    recordsChanged: 1,
    newPersons: 0,
    newFamilies: 0,
    recordLabels: { [id]: id },
    recordKinds: { [id]: "individual" },
    familySpouses: {},
    customTags: {},
  };
}

describe("enrichEditReport — source citations", () => {
  it("shows an added record-level SOUR citation by its source title and page", () => {
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n"));
    const after = dataset(
      wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SOUR @S1@\n2 PAGE 5\n0 @S1@ SOUR\n1 TITL Katarina Abdonec - WW2 - SIstory.si\n"),
    );
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const sources = report.changes.filter((c) => c.field === "field.sources");
    expect(sources).toHaveLength(1);
    expect(sources[0].to).toBe("Katarina Abdonec - WW2 - SIstory.si (5)");
    expect(sources[0].action).toBe("both");
  });

  it("names the page image attached beside an event's citation", () => {
    // A file that keeps page links on events gets the register page hung on the
    // event with every citation the source tools write. The preview showed the
    // citation and nothing else, leaving the reader to wonder whether the page
    // came with it.
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1804\n"));
    const after = dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1804\n2 SOUR @S1@\n3 PAGE 38\n2 OBJE @O1@\n" +
          "0 @S1@ SOUR\n1 TITL Births (Rođeni) 1759-1812, Ravna Gora\n" +
          "0 @O1@ OBJE\n1 FILE https://www.familysearch.org/ark:/61903/3:1:XYZ?i=37\n" +
          "1 TITL Births (Rođeni) 1759-1812, Ravna Gora\n",
      ),
    );
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const birt = report.changes.filter((c) => c.group === "event.BIRT");
    expect(birt).toHaveLength(1);
    expect(birt[0].segments).toEqual([
      { text: "1804", state: "same" },
      { text: "Births (Rođeni) 1759-1812, Ravna Gora (38)", state: "changed" },
      { text: "🔗 Births (Rođeni) 1759-1812, Ravna Gora", state: "changed" },
    ]);
  });

  it("shows a citation added to an event as that event's change", () => {
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 DEAT\n2 DATE 1944\n"));
    const after = dataset(
      wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 DEAT\n2 DATE 1944\n2 SOUR @S1@\n0 @S1@ SOUR\n1 TITL Katarina Abdonec - WW2 - SIstory.si\n"),
    );
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const deat = report.changes.filter((c) => c.group === "event.DEAT");
    expect(deat).toHaveLength(1);
    expect(deat[0].segments).toEqual([
      { text: "1944", state: "same" },
      { text: "Katarina Abdonec - WW2 - SIstory.si", state: "changed" },
    ]);
  });
});

describe("enrichEditReport — identity fields", () => {
  it("marks name and sex as the person's own identity, unlike an event's fields", () => {
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1900\n"));
    const after = dataset(wrap("0 @I1@ INDI\n1 NAME Ivan /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1901\n"));
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const identity = report.changes.filter((c) => c.identity).map((c) => c.field);
    expect(identity).toEqual(["field.given", "field.sex"]);
    expect(report.changes.find((c) => c.group === "event.BIRT")?.identity).toBeUndefined();
  });
});

describe("enrichEditReport — event diffing", () => {
  it("marks an edited event's changed sub-field, leaving the rest in their normal color, with no new-event icon", () => {
    const before = dataset(
      wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 RESI\n2 PLAC Kranj\n2 ADDR Main 1\n"),
    );
    const after = dataset(
      wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 RESI\n2 DATE 1934\n2 PLAC Kranj\n2 ADDR Main 1\n"),
    );
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const resi = report.changes.filter((c) => c.group === "event.RESI");
    expect(resi).toHaveLength(1);
    expect(resi[0].segments).toEqual([
      { text: "1934", state: "changed" },
      { text: "Kranj", state: "same" },
      { text: "Main 1", state: "same" },
    ]);
  });

  it("shows a geocode write-back (MAP under an existing PLAC) as the event's changed coordinate", () => {
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1901\n2 PLAC Kranj\n"));
    const after = dataset(
      wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1901\n2 PLAC Kranj\n3 MAP\n4 LATI N46.2389\n4 LONG E14.3556\n"),
    );
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const birt = report.changes.filter((c) => c.group === "event.BIRT");
    expect(birt).toHaveLength(1);
    expect(birt[0].segments).toEqual([
      { text: "1901", state: "same" },
      { text: "Kranj", state: "same" },
      { text: "46.2389, 14.3556", state: "changed" },
    ]);
  });

  it("renders a brand-new event as a plain addition (no segments)", () => {
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n"));
    const after = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 OCCU Engineer\n2 DATE 1960\n"));
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const occu = report.changes.filter((c) => c.group === "event.OCCU");
    expect(occu).toHaveLength(1);
    expect(occu[0].segments).toBeUndefined();
    expect(occu[0].action).toBe("both");
    expect(occu[0].to).toBe("Engineer · 1960");
  });

  it("renders a fully removed event as a plain removal (no segments)", () => {
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 OCCU Engineer\n2 DATE 1960\n"));
    const after = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n"));
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const occu = report.changes.filter((c) => c.group === "event.OCCU");
    expect(occu).toHaveLength(1);
    expect(occu[0].segments).toBeUndefined();
    expect(occu[0].action).toBe("incoming");
    expect(occu[0].from).toBe("Engineer · 1960");
    expect(occu[0].to).toBe("");
  });

  it("does not pair two unrelated events of the same tag (no shared sub-field)", () => {
    // Different date AND place, so the events share no sub-field and aren't a
    // place-only edit — they must stay separate (a removal plus an addition).
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 RESI\n2 DATE 1900\n2 PLAC Kranj\n"));
    const after = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 RESI\n2 DATE 2000\n2 PLAC Maribor\n"));
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const resi = report.changes.filter((c) => c.group === "event.RESI");
    expect(resi).toHaveLength(2);
    expect(resi.every((c) => !c.segments)).toBe(true);
  });
});

describe("enrichEditReport — event tags outside the canonical lists", () => {
  const famReport = (id: string): ChangeReport => ({
    ...baseReport(id),
    recordKinds: { [id]: "family" },
  });

  it("shows a geocode write on a CHRA (adult christening) not in the tag list", () => {
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 CHRA\n2 DATE 1920\n2 PLAC Kranj\n"));
    const after = dataset(
      wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 CHRA\n2 DATE 1920\n2 PLAC Kranj\n3 MAP\n4 LATI N46.2389\n4 LONG E14.3556\n"),
    );
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const chra = report.changes.filter((c) => c.group === "event.CHRA");
    expect(chra).toHaveLength(1);
    expect(chra[0].segments).toContainEqual({ text: "46.2389, 14.3556", state: "changed" });
  });

  it("shows a place rename on a family MARB (banns) event", () => {
    const before = dataset(
      wrap("0 @F1@ FAM\n1 HUSB @I1@\n1 MARB\n2 DATE 1900\n2 PLAC Krupa 7,Semič,\n0 @I1@ INDI\n1 NAME Janez /Novak/\n1 FAMS @F1@\n"),
    );
    const after = dataset(
      wrap("0 @F1@ FAM\n1 HUSB @I1@\n1 MARB\n2 DATE 1900\n2 PLAC Krupa,Semič,Slovenia\n0 @I1@ INDI\n1 NAME Janez /Novak/\n1 FAMS @F1@\n"),
    );
    const snapshots = new Map([["@F1@", before.families.get("@F1@")!.raw]]);
    const report = enrichEditReport(famReport("@F1@"), after, new Map(), snapshots, tr);

    const marb = report.changes.filter((c) => c.group === "event.MARB");
    expect(marb).toHaveLength(1);
    // The value it replaced rides with it, for the preview to strike through.
    expect(marb[0].segments).toContainEqual({
      text: "Krupa,Semič,Slovenia",
      state: "changed",
      from: "Krupa 7,Semič,",
    });
  });

  it("shows a date change on a vendor event tag with event substructure", () => {
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 _KRST\n2 DATE 1901\n2 PLAC Kranj\n"));
    const after = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 _KRST\n2 DATE 1902\n2 PLAC Kranj\n"));
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const ev = report.changes.filter((c) => c.group === "event._KRST");
    expect(ev).toHaveLength(1);
  });

  it("does not diff structureless value tags (_UID) as events", () => {
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 _UID AAAA\n"));
    const after = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 _UID BBBB\n"));
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    expect(report.changes.filter((c) => c.group === "event._UID")).toHaveLength(0);
  });

  it("shows an added or edited FamilySearch id under its own field label", () => {
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n"));
    const after = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 _FID GPZG-CXL\n"));
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const fsid = report.changes.filter((c) => c.field === "field.fsid");
    expect(fsid).toHaveLength(1);
    expect(fsid[0].to).toBe("GPZG-CXL");
    // And never mis-diffed as an event.
    expect(report.changes.filter((c) => c.group === "event._FID")).toHaveLength(0);
  });
});

describe("enrichEditReport — private markers", () => {
  // The save preview is the last screen before the file is written, and a note
  // kept out of publishing read there exactly like one meant for it.
  it("flags an added inline note that is marked private", () => {
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n"));
    const after = dataset(
      wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 NOTE https://web.facebook.com/janez\n2 RESN privacy\n"),
    );
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const notes = report.changes.filter((c) => c.field === "field.notes");
    expect(notes).toHaveLength(1);
    expect(notes[0].private).toBe(true);
  });

  it("leaves an ordinary note unflagged", () => {
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n"));
    const after = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 NOTE Baptism witness\n"));
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    expect(report.changes.find((c) => c.field === "field.notes")?.private).toBeUndefined();
  });

  it("follows a pointer note to the shared record holding its flag", () => {
    // The editor writes a pointer note's flag on the `0 @N1@ NOTE` record, so
    // reading only the pointer would call every shared private note public.
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n"));
    const after = dataset(
      wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 NOTE @N1@\n0 @N1@ NOTE a private remark\n1 RESN privacy\n"),
    );
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    expect(report.changes.find((c) => c.field === "field.notes")?.private).toBe(true);
  });

  it("shows a note whose text stayed put but whose flag was turned on", () => {
    // Nothing a value diff can see changed, so this row did not exist at all —
    // the person's card carried the EDITED badge and not one line under it.
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 NOTE https://web.facebook.com/masaakukic\n"));
    const after = dataset(
      wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 NOTE https://web.facebook.com/masaakukic\n2 RESN privacy\n"),
    );
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const notes = report.changes.filter((c) => c.field === "field.notes");
    expect(notes).toHaveLength(1);
    expect(notes[0].private).toBe(true);
    expect(notes[0].privacyChanged).toBe(true);
    // The value is context, not something newly added.
    expect(notes[0].segments).toEqual([{ text: "https://web.facebook.com/masaakukic", state: "same" }]);
  });

  it("shows a note that stopped being private", () => {
    // The direction that gives data away: silence here would read as "nothing
    // about privacy happened".
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 NOTE a remark\n2 RESN privacy\n"));
    const after = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 NOTE a remark\n"));
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const notes = report.changes.filter((c) => c.field === "field.notes");
    expect(notes).toHaveLength(1);
    expect(notes[0].privacyChanged).toBe(true);
    expect(notes[0].private).toBeUndefined();
  });

  it("shows a pointer note by its text, not by its xref", () => {
    // The reader is being asked to approve a note; "@N1@" tells them nothing
    // about what it says.
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n"));
    const after = dataset(
      wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 NOTE @N1@\n0 @N1@ NOTE https://web.facebook.com/ales.znidar.9\n"),
    );
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const notes = report.changes.filter((c) => c.field === "field.notes");
    expect(notes).toHaveLength(1);
    expect(notes[0].to).toBe("https://web.facebook.com/ales.znidar.9");
  });

  it("flags an event marked private, and reads the flag as the save will write it", () => {
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1901\n"));
    const after = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1901\n2 PLAC Kranj\n2 RESN privacy\n"));
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const birt = report.changes.filter((c) => c.group === "event.BIRT");
    expect(birt).toHaveLength(1);
    expect(birt[0].private).toBe(true);
  });

  it("shows an event whose only change is being marked private", () => {
    // The flag stays out of the summary, so the pair reads as identical text —
    // without comparing it on its own the save preview had nothing to show for
    // a record it still reported as changed.
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1901\n"));
    const after = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 1901\n2 RESN privacy\n"));
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const report = enrichEditReport(baseReport("@I1@"), after, snapshots, new Map(), tr);

    const birt = report.changes.filter((c) => c.group === "event.BIRT");
    expect(birt).toHaveLength(1);
    expect(birt[0].private).toBe(true);
    // The date itself did not change, and still reads as untouched.
    expect(birt[0].segments).toEqual([{ text: "1901", state: "same" }]);
  });
});

// ---------------------------------------------------------------------------
// buildEditReport — the record-level skeleton the save preview groups by, built
// before enrichEditReport fills in per-field detail.
// ---------------------------------------------------------------------------

const MAIN = wrap(
  "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
    "0 @I2@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 FAMS @F1@\n" +
    "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n",
);

describe("buildEditReport", () => {
  const ds = () => dataset(MAIN);
  const loadedPeople = new Set(["@I1@", "@I2@"]);
  const loadedFams = new Set(["@F1@"]);

  it("describes a shared record edited through a person, and names it by its text", () => {
    // Ticking a shared note's 🔒 from someone's card changes the *record*, but
    // dirty tracking hangs that on the owner, so the id never reaches
    // `changedRecordIds`. The owner's own diff has nothing to say about it —
    // their pointer is untouched — which left the save audit to catch the
    // record and report it as changed with no detail at all.
    const withNote = dataset(
      wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 NOTE @N1@\n0 @N1@ NOTE a private remark\n1 PRIV\n"),
    );
    const snapshot = dataset(
      wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 NOTE @N1@\n0 @N1@ NOTE a private remark\n"),
    ).records.find((r) => r.xref === "@N1@")!;

    const report = buildEditReport(
      new Set(), new Set(), withNote, loadedPeople, loadedFams,
      new Map(), new Map(),
      new Set(), // the record is NOT in changedRecordIds — that is the point
      new Map([["@N1@", { value: snapshot, owner: { kind: "individual" as const, id: "@I1@" } }]]),
    );

    expect(report.recordKinds["@N1@"]).toBe("record");
    expect(report.recordLabels["@N1@"]).toBe("a private remark");
    // Described — so the audit leaves it alone instead of warning about it.
    expect(report.changes.some((c) => c.recordId === "@N1@")).toBe(true);
  });

  it("emits one placeholder change per changed record, labelled and kinded", () => {
    const report = buildEditReport(new Set(["@I1@"]), new Set(), ds(), loadedPeople, loadedFams);

    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]).toMatchObject({ recordId: "@I1@", field: "", newRecord: false, removedRecord: false });
    expect(report.recordLabels["@I1@"]).toBe("Janez Novak");
    expect(report.recordKinds["@I1@"]).toBe("individual");
    expect(report.recordsChanged).toBe(1);
  });

  it("counts a person absent from the loaded set as newly added", () => {
    const withNew = dataset(MAIN.replace("0 TRLR", "0 @I3@ INDI\n1 NAME Nova /Oseba/\n0 TRLR"));
    const report = buildEditReport(new Set(["@I3@"]), new Set(), withNew, loadedPeople, loadedFams);

    expect(report.newPersons).toBe(1);
    expect(report.changes[0].newRecord).toBe(true);
    expect(report.changes[0].removedRecord).toBe(false);
  });

  it("marks a loaded person now missing from the dataset as removed", () => {
    const report = buildEditReport(new Set(["@GONE@"]), new Set(), ds(), new Set(["@GONE@"]), loadedFams);

    expect(report.changes[0]).toMatchObject({ recordId: "@GONE@", newRecord: false, removedRecord: true });
    expect(report.newPersons).toBe(0);
  });

  it("labels a removed person from their pre-edit snapshot, not their bare xref", () => {
    const before = ds();
    const snapshots = new Map([["@I1@", before.individuals.get("@I1@")!.raw]]);
    const without = dataset(MAIN.replace("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n", ""));

    const report = buildEditReport(new Set(["@I1@"]), new Set(), without, loadedPeople, loadedFams, snapshots);
    expect(report.recordLabels["@I1@"]).toBe("Janez Novak");
  });

  it("falls back to the xref when neither the record nor a snapshot names them", () => {
    const report = buildEditReport(new Set(["@GONE@"]), new Set(), ds(), new Set(["@GONE@"]), loadedFams);
    expect(report.recordLabels["@GONE@"]).toBe("@GONE@");
  });

  // An edit can undo an earlier one within the session — connecting the second
  // parent drops the stub family the first parent created, and takes back the
  // pointer it added to the other parent. Both are still flagged dirty; neither
  // leaves a mark on the file, so neither belongs in the report.
  it("passes over a record created and then removed again", () => {
    const report = buildEditReport(new Set(), new Set(["@FSTUB@"]), ds(), loadedPeople, loadedFams);

    expect(report.changes).toEqual([]);
    expect(report.newFamilies).toBe(0);
    expect(report.recordsChanged).toBe(0);
  });

  it("passes over a record edited back to how it was", () => {
    const current = ds();
    // Its baseline snapshot is the record exactly as it stands now.
    const snapshots = new Map([["@I1@", cloneNode(current.individuals.get("@I1@")!.raw)]]);
    const report = buildEditReport(new Set(["@I1@"]), new Set(), current, loadedPeople, loadedFams, snapshots);

    expect(report.changes).toEqual([]);
    expect(report.recordsChanged).toBe(0);
  });

  it("still reports a record that differs from its baseline", () => {
    const current = ds();
    const snapshot = cloneNode(current.individuals.get("@I1@")!.raw);
    snapshot.children.push({ level: 1, tag: "NOTE", value: "gone since", children: [] });
    const report = buildEditReport(new Set(["@I1@"]), new Set(), current, loadedPeople, loadedFams, new Map([["@I1@", snapshot]]));

    expect(report.changes).toHaveLength(1);
    expect(report.recordsChanged).toBe(1);
  });

  it("labels a family by its spouses, husband first", () => {
    const report = buildEditReport(new Set(), new Set(["@F1@"]), ds(), loadedPeople, loadedFams);

    expect(report.recordLabels["@F1@"]).toBe("Janez Novak + Ana Kos");
    expect(report.recordKinds["@F1@"]).toBe("family");
    expect(report.familySpouses["@F1@"]).toEqual([
      { id: "@I1@", name: "Janez Novak" },
      { id: "@I2@", name: "Ana Kos" },
    ]);
  });

  it("recovers a deleted family's spouse names from the snapshots", () => {
    const before = ds();
    const famSnap = new Map([["@F1@", before.families.get("@F1@")!.raw]]);
    const personSnaps = new Map([
      ["@I1@", before.individuals.get("@I1@")!.raw],
      ["@I2@", before.individuals.get("@I2@")!.raw],
    ]);
    const without = dataset(MAIN.replace("0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n", ""));

    const report = buildEditReport(new Set(), new Set(["@F1@"]), without, loadedPeople, loadedFams, personSnaps, famSnap);
    expect(report.recordLabels["@F1@"]).toBe("Janez Novak + Ana Kos");
    expect(report.changes[0].removedRecord).toBe(true);
  });

  it("counts a family absent from the loaded set as new", () => {
    const report = buildEditReport(new Set(), new Set(["@F1@"]), ds(), loadedPeople, new Set());
    expect(report.newFamilies).toBe(1);
  });

  it("falls back to the xref for a family with no resolvable spouses", () => {
    const solo = dataset(wrap("0 @F9@ FAM\n1 CHIL @I1@\n"));
    const report = buildEditReport(new Set(), new Set(["@F9@"]), solo, loadedPeople, new Set(["@F9@"]));

    expect(report.recordLabels["@F9@"]).toBe("@F9@");
    expect(report.familySpouses["@F9@"]).toBeUndefined();
  });

  it("reports people and families together", () => {
    const report = buildEditReport(new Set(["@I1@", "@I2@"]), new Set(["@F1@"]), ds(), loadedPeople, loadedFams);
    expect(report.recordsChanged).toBe(3);
    expect(report.changes).toHaveLength(3);
  });

  it("labels an edited repository by its NAME, not its bare xref", () => {
    const withRepo = dataset(MAIN.replace("0 @F1@", "0 @R1@ REPO\n1 NAME Matricula Online\n0 @F1@"));
    const snapshot = dataset(wrap("0 @R1@ REPO\n1 NAME Nadškofijski arhiv\n")).records.find((r) => r.xref === "@R1@")!;

    const report = buildEditReport(
      new Set(), new Set(), withRepo, loadedPeople, loadedFams, undefined, undefined,
      new Set(["@R1@"]), new Map([["@R1@", { value: snapshot }]]),
    );
    expect(report.recordLabels["@R1@"]).toBe("🏛 Matricula Online");
    expect(report.recordKinds["@R1@"]).toBe("record");
  });

  it("names the repository a source has left, though the file no longer holds it", () => {
    // The regroup moves a source onto the country's repository and removes the
    // one it emptied. Both halves of that row must read as names: the record
    // it left is gone from the file, and its xref means nothing to a reader.
    const after = dataset(
      MAIN.replace(
        "0 @F1@",
        "0 @R2@ REPO\n1 NAME FamilySearch.org - Croatia\n0 @S1@ SOUR\n1 TITL Births (Rođeni) 1857-1884, Ravna Gora\n1 REPO @R2@\n0 @F1@",
      ),
    );
    const sourceBefore = dataset(
      wrap("0 @S1@ SOUR\n1 TITL Births (Rođeni) 1857-1884, Ravna Gora\n1 REPO @R1@\n"),
    ).records.find((r) => r.xref === "@S1@")!;
    const repoBefore = dataset(
      wrap("0 @R1@ REPO\n1 NAME FamilySearch.org - Croatia Church Books 1516-1994\n"),
    ).records.find((r) => r.xref === "@R1@")!;

    const report = buildEditReport(
      new Set(), new Set(), after, loadedPeople, loadedFams, undefined, undefined,
      new Set(["@S1@", "@R1@"]),
      new Map([
        ["@S1@", { value: sourceBefore }],
        ["@R1@", { value: repoBefore }],
      ]),
    );
    const row = report.changes.find((c) => c.field === "REPO");
    expect(row?.from).toBe("🏛 FamilySearch.org - Croatia Church Books 1516-1994");
    expect(row?.to).toBe("🏛 FamilySearch.org - Croatia");
  });

  it("returns an empty report when nothing changed", () => {
    const report = buildEditReport(new Set(), new Set(), ds(), loadedPeople, loadedFams);
    expect(report).toMatchObject({ changes: [], recordsChanged: 0, newPersons: 0, newFamilies: 0 });
  });
});

describe("combineReports", () => {
  const mk = (over: Partial<ChangeReport>): ChangeReport => ({ ...baseReport("@X@"), ...over });

  it("concatenates changes and sums the new-record counts", () => {
    const a = mk({ changes: [{ recordId: "@I1@", field: "a", from: "", to: "", action: "incoming" }], newPersons: 1 });
    const b = mk({ changes: [{ recordId: "@I2@", field: "b", from: "", to: "", action: "incoming" }], newFamilies: 2 });

    const c = combineReports(a, b);
    expect(c.changes).toHaveLength(2);
    expect(c.newPersons).toBe(1);
    expect(c.newFamilies).toBe(2);
  });

  it("counts distinct records, so a record touched by both sides counts once", () => {
    const one = { recordId: "@I1@", field: "a", from: "", to: "", action: "incoming" as const };
    const two = { recordId: "@I1@", field: "b", from: "", to: "", action: "incoming" as const };

    expect(combineReports(mk({ changes: [one] }), mk({ changes: [two] })).recordsChanged).toBe(1);
  });

  it("merges the label/kind/spouse maps with b winning a key collision", () => {
    const a = mk({ recordLabels: { "@I1@": "from a" }, recordKinds: { "@I1@": "individual" } });
    const b = mk({ recordLabels: { "@I1@": "from b" }, recordKinds: { "@I1@": "family" } });

    const c = combineReports(a, b);
    expect(c.recordLabels["@I1@"]).toBe("from b");
    expect(c.recordKinds["@I1@"]).toBe("family");
  });

  it("concatenates deferred entries", () => {
    const a = mk({ deferred: [{ recordId: "@I1@", field: "f", reason: "r" }] });
    expect(combineReports(a, mk({})).deferred).toHaveLength(1);
  });
});

describe("removeRecordFromReport", () => {
  const base: ChangeReport = {
    ...baseReport("@I1@"),
    changes: [
      { recordId: "@I1@", field: "", from: "", to: "", action: "incoming", newRecord: true },
      { recordId: "@I1@", field: "name", from: "A", to: "B", action: "incoming" },
      { recordId: "@I2@", field: "name", from: "C", to: "D", action: "incoming" },
    ],
    recordLabels: { "@I1@": "One", "@I2@": "Two" },
    recordKinds: { "@I1@": "individual", "@I2@": "individual" },
    newPersons: 1,
    recordsChanged: 2,
  };

  it("drops every change for that record and keeps the others", () => {
    const out = removeRecordFromReport(base, "@I1@");
    expect(out.changes).toHaveLength(1);
    expect(out.changes[0].recordId).toBe("@I2@");
    expect(out.recordsChanged).toBe(1);
  });

  it("forgets the record's label, kind and spouse entry", () => {
    const out = removeRecordFromReport(base, "@I1@");
    expect(out.recordLabels).not.toHaveProperty("@I1@");
    expect(out.recordKinds).not.toHaveProperty("@I1@");
    expect(out.recordLabels["@I2@"]).toBe("Two");
  });

  it("decrements newPersons when the removed record was a new individual", () => {
    expect(removeRecordFromReport(base, "@I1@").newPersons).toBe(0);
  });

  it("decrements newFamilies when the removed record was a new family", () => {
    const fam: ChangeReport = {
      ...base,
      changes: [{ recordId: "@F1@", field: "", from: "", to: "", action: "incoming", newRecord: true }],
      recordKinds: { "@F1@": "family" },
      newFamilies: 1,
    };
    expect(removeRecordFromReport(fam, "@F1@").newFamilies).toBe(0);
  });

  it("leaves the new-record counts alone for a record that was only modified", () => {
    expect(removeRecordFromReport(base, "@I2@").newPersons).toBe(1);
  });

  it("is a no-op for an id the report does not mention", () => {
    const out = removeRecordFromReport(base, "@NOPE@");
    expect(out.changes).toHaveLength(3);
    expect(out.newPersons).toBe(1);
  });

  it("does not mutate the report it was given", () => {
    const snapshot = JSON.stringify(base);
    removeRecordFromReport(base, "@I1@");
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// enrichEditReport — family records and membership changes
// ---------------------------------------------------------------------------

function famReport(id: string): ChangeReport {
  return { ...baseReport(id), recordKinds: { [id]: "family" } };
}

const COUPLE =
  "0 @I1@ INDI\n1 NAME Janez /Novak/\n0 @I2@ INDI\n1 NAME Ana /Kos/\n" +
  "0 @C1@ INDI\n1 NAME Mojca /Novak/\n0 @C2@ INDI\n1 NAME Tone /Novak/\n";

describe("enrichEditReport — family membership", () => {
  const enrichFam = (beforeFam: string, afterFam: string) => {
    const before = dataset(wrap(COUPLE + beforeFam));
    const after = dataset(wrap(COUPLE + afterFam));
    return enrichEditReport(
      famReport("@F1@"),
      after,
      new Map(),
      new Map([["@F1@", before.families.get("@F1@")!.raw]]),
      tr,
    );
  };

  it("reports an added husband by name", () => {
    const report = enrichFam("0 @F1@ FAM\n1 WIFE @I2@\n", "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n");
    const husb = report.changes.filter((c) => c.field === "field.husband");
    expect(husb).toHaveLength(1);
    expect(husb[0]).toMatchObject({ from: "", to: "Janez Novak", action: "both" });
  });

  it("reports a removed wife by name", () => {
    const report = enrichFam("0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n", "0 @F1@ FAM\n1 HUSB @I1@\n");
    const wife = report.changes.filter((c) => c.field === "field.wife");
    expect(wife).toHaveLength(1);
    expect(wife[0]).toMatchObject({ from: "Ana Kos", to: "", action: "incoming" });
  });

  it("reports a replaced spouse as both a loss and a gain", () => {
    const report = enrichFam("0 @F1@ FAM\n1 HUSB @I1@\n", "0 @F1@ FAM\n1 HUSB @C2@\n");
    const husb = report.changes.filter((c) => c.field === "field.husband");
    expect(husb.map((c) => [c.from, c.to])).toEqual([["Janez Novak", ""], ["", "Tone Novak"]]);
  });

  it("says nothing about a spouse that did not change", () => {
    const report = enrichFam("0 @F1@ FAM\n1 HUSB @I1@\n", "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n");
    expect(report.changes.filter((c) => c.field === "field.husband")).toHaveLength(0);
  });

  it("reports added and removed children by name", () => {
    const report = enrichFam(
      "0 @F1@ FAM\n1 HUSB @I1@\n1 CHIL @C1@\n",
      "0 @F1@ FAM\n1 HUSB @I1@\n1 CHIL @C2@\n",
    );
    const kids = report.changes.filter((c) => c.field === "field.child");
    expect(kids.map((c) => [c.from, c.to])).toEqual([["Mojca Novak", ""], ["", "Tone Novak"]]);
  });

  it("leaves an unchanged child list out of the report", () => {
    const report = enrichFam(
      "0 @F1@ FAM\n1 HUSB @I1@\n1 CHIL @C1@\n",
      "0 @F1@ FAM\n1 HUSB @I1@\n1 CHIL @C1@\n1 MARR\n2 DATE 1920\n",
    );
    expect(report.changes.filter((c) => c.field === "field.child")).toHaveLength(0);
  });

  it("falls back to the xref for a member with no resolvable name", () => {
    const report = enrichFam("0 @F1@ FAM\n", "0 @F1@ FAM\n1 HUSB @GHOST@\n");
    expect(report.changes.find((c) => c.field === "field.husband")?.to).toBe("@GHOST@");
  });

  it("returns the report untouched when the family has no snapshot", () => {
    const after = dataset(wrap(COUPLE + "0 @F1@ FAM\n1 HUSB @I1@\n"));
    const base = famReport("@F1@");
    expect(enrichEditReport(base, after, new Map(), new Map(), tr)).toBe(base);
  });
});

describe("enrichEditReport — record-level links", () => {
  it("groups added links into one change carrying the URLs as icons", () => {
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n"));
    const after = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 WWW https://a.example\n1 WWW https://b.example\n"));
    const report = enrichEditReport(
      baseReport("@I1@"), after,
      new Map([["@I1@", before.individuals.get("@I1@")!.raw]]), new Map(), tr,
    );

    const links = report.changes.filter((c) => c.links?.length);
    expect(links).toHaveLength(1);
    expect(links[0].links).toEqual(["https://a.example", "https://b.example"]);
    expect(links[0].action).toBe("both");
  });

  it("reports a removed link as a plain from/to row", () => {
    const before = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 WWW https://gone.example\n"));
    const after = dataset(wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n"));
    const report = enrichEditReport(
      baseReport("@I1@"), after,
      new Map([["@I1@", before.individuals.get("@I1@")!.raw]]), new Map(), tr,
    );

    const removed = report.changes.find((c) => c.from === "https://gone.example");
    expect(removed).toMatchObject({ to: "", action: "incoming" });
  });
});

describe("enrichEditReport — a deleted person's memberships", () => {
  it("lists the families a deleted person belonged to", () => {
    // The pass reads the individual's own FAMS/FAMC back-links, so the
    // snapshot must carry them (a real edited record always does).
    const before = dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 FAMS @F1@\n1 FAMC @F2@\n" +
          "0 @I2@ INDI\n1 NAME Ana /Kos/\n" +
          "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n0 @F2@ FAM\n1 CHIL @I1@\n",
      ),
    );
    const snap = before.individuals.get("@I1@")!.raw;
    // @I1@ is gone from the current dataset entirely.
    const after = dataset(wrap("0 @I2@ INDI\n1 NAME Ana /Kos/\n"));

    const report = enrichEditReport(
      { ...baseReport("@I1@"), recordLabels: { "@F1@": "Janez + Ana", "@F2@": "Rodbina" } },
      after, new Map([["@I1@", snap]]), new Map(), tr,
    );

    const spouseOf = report.changes.find((c) => c.field === "field.spouseOf");
    const childOf = report.changes.find((c) => c.field === "field.childOf");
    expect(spouseOf).toMatchObject({ from: "Janez + Ana", to: "" });
    expect(childOf).toMatchObject({ from: "Rodbina", to: "" });
  });

  it("reports a membership gained by an edited person", () => {
    const before = dataset(wrap(COUPLE + "0 @F1@ FAM\n1 HUSB @I1@\n"));
    const after = dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 FAMS @F1@\n0 @I2@ INDI\n1 NAME Ana /Kos/\n" +
          "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n",
      ),
    );
    const report = enrichEditReport(
      baseReport("@I1@"), after,
      new Map([["@I1@", before.individuals.get("@I1@")!.raw]]), new Map(), tr,
    );

    const gained = report.changes.find((c) => c.field === "field.spouseOf");
    expect(gained).toMatchObject({ from: "", to: "Janez Novak + Ana Kos", action: "both" });
  });
});
