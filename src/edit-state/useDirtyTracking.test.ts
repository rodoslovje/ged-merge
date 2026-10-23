import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "../testing/fakeReact";
import { useDirtyTracking } from "./useDirtyTracking";
import { buildDataset } from "../gedcom/builder";
import { cloneNode } from "../gedcom/node";
import { parseGedcom } from "../gedcom/parser";
import type { Dataset, GedNode } from "../gedcom/types";
import { applyRecordPatches, markMechanical, type RecordPatch } from "../ui/historyTypes";

vi.mock("react", () => import("../testing/fakeReact"));

/**
 * The unsaved-changes tracker the Save button, the save report and the
 * cached session all read: which records differ from the file as loaded (or
 * last saved), the pre-edit snapshots that tell "changed" from "changed and
 * changed back", and the substantive-step counts behind the CHAN stamps.
 * Driven the way App drives it — patches pushed, applied, undone, redone.
 */

const FILE = [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 FAMS @F1@",
  "0 @I2@ INDI", "1 NAME Ana /Kos/", "1 SEX F", "1 FAMS @F1@",
  "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@",
  "0 @S1@ SOUR", "1 TITL Krstna knjiga",
  "0 @S2@ SOUR", "1 TITL Poročna knjiga",
  "0 TRLR", "",
].join("\n");

const load = (text = FILE): Dataset => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer as ArrayBuffer));

function mount(ds: Dataset) {
  const h = renderHook(() => useDirtyTracking());
  h.result.current.resetOnLoad(ds);
  return h;
}

/** An edit of one record's first line value (NAME / HUSB / TITL), applied to
 *  `ds` and returned as the patch App would push. */
function setFirstValue(ds: Dataset, type: RecordPatch["type"], id: string, value: string): RecordPatch {
  const raw =
    type === "individual" ? ds.individuals.get(id)!.raw : type === "family" ? ds.families.get(id)!.raw : ds.records.find((r) => r.xref === id)!;
  const before = cloneNode(raw);
  const after = cloneNode(raw);
  after.children[0].value = value;
  const patch: RecordPatch = { type, id, before, after };
  applyRecordPatches(ds, [patch], "redo");
  return patch;
}

/** A new person created during the session. */
function addPerson(ds: Dataset, id: string): RecordPatch {
  const after: GedNode = { level: 0, xref: id, tag: "INDI", value: "", children: [{ level: 1, tag: "NAME", value: "Nov /Človek/", children: [] }] };
  const patch: RecordPatch = { type: "individual", id, before: null, after };
  applyRecordPatches(ds, [patch], "redo");
  return patch;
}

/** Push as App does: snapshots with the undo step, then the people and
 *  families the edit touched marked dirty (shared records flag themselves). */
function push(h: ReturnType<typeof mount>, patches: RecordPatch[], ds?: Dataset) {
  h.result.current.captureSnapshotsForPush(patches);
  if (ds) for (const p of patches) if (p.type !== "record") h.result.current.markDirty(p.type, p.id, ds);
}
function undo(h: ReturnType<typeof mount>, ds: Dataset, patches: RecordPatch[]) {
  applyRecordPatches(ds, patches, "undo");
  h.result.current.onPatchApplied(patches, "undo", ds);
}
function redo(h: ReturnType<typeof mount>, ds: Dataset, patches: RecordPatch[]) {
  applyRecordPatches(ds, patches, "redo");
  h.result.current.onPatchApplied(patches, "redo", ds);
}
const changed = (h: ReturnType<typeof mount>) => ({
  people: [...h.result.current.changedPersonIds],
  families: [...h.result.current.changedFamilyIds],
  records: [...h.result.current.changedRecordIds],
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useDirtyTracking", () => {
  it("a loaded file is clean; an edit makes its record dirty and undo makes it clean again", () => {
    const ds = load();
    const h = mount(ds);
    expect(changed(h)).toEqual({ people: [], families: [], records: [] });
    const p = setFirstValue(ds, "individual", "@I1@", "Janez /Kranjc/");
    push(h, [p], ds);
    expect(changed(h).people).toEqual(["@I1@"]);
    expect(h.result.current.personSnapshots.current.get("@I1@")?.children[0].value).toBe("Janez /Novak/");
    expect(h.result.current.isSubstantive("@I1@")).toBe(true);
    undo(h, ds, [p]);
    expect(changed(h).people).toEqual([]);
    expect(h.result.current.isSubstantive("@I1@")).toBe(false);
    redo(h, ds, [p]);
    expect(changed(h).people).toEqual(["@I1@"]);
  });

  it("families and shared records are tracked on their own flags", () => {
    const ds = load();
    const h = mount(ds);
    const fam = setFirstValue(ds, "family", "@F1@", "@I2@");
    const src = setFirstValue(ds, "record", "@S1@", "Mrliška knjiga");
    push(h, [fam, src], ds);
    expect(changed(h)).toEqual({ people: [], families: ["@F1@"], records: ["@S1@"] });
    undo(h, ds, [fam, src]);
    expect(changed(h)).toEqual({ people: [], families: [], records: [] });
  });

  it("shared records edited from a person's card keep that person dirty until the last is undone", () => {
    const ds = load();
    const h = mount(ds);
    const owner = { kind: "individual" as const, id: "@I1@" };
    const s1 = { ...setFirstValue(ds, "record", "@S1@", "Krstna knjiga II"), owner };
    push(h, [s1], ds);
    h.result.current.markDirty("individual", "@I1@", ds);
    const s2 = { ...setFirstValue(ds, "record", "@S2@", "Poročna knjiga II"), owner };
    push(h, [s2], ds);
    expect(changed(h)).toEqual({ people: ["@I1@"], families: [], records: [] });
    undo(h, ds, [s2]);
    expect(changed(h).people).toEqual(["@I1@"]);
    undo(h, ds, [s1]);
    expect(changed(h).people).toEqual([]);
    redo(h, ds, [s1]);
    expect(changed(h).people).toEqual(["@I1@"]);
  });

  it("a mechanical pass dirties a record without making it substantive", () => {
    const ds = load();
    const h = mount(ds);
    const p = markMechanical([setFirstValue(ds, "individual", "@I2@", "Ana /Kos Novak/")]);
    push(h, p, ds);
    expect(changed(h).people).toEqual(["@I2@"]);
    expect(h.result.current.isSubstantive("@I2@")).toBe(false);
  });

  it("markDirty snapshots a loaded record once, and never one made this session", () => {
    const ds = load();
    const h = mount(ds);
    h.result.current.ensureBaseline();
    h.result.current.markDirty("individual", "@I1@", ds);
    ds.individuals.get("@I1@")!.raw.children[0].value = "Changed /Name/";
    h.result.current.markDirty("individual", "@I1@", ds);
    expect(h.result.current.personSnapshots.current.get("@I1@")?.children[0].value).toBe("Janez /Novak/");
    addPerson(ds, "@I9@");
    h.result.current.markDirty("individual", "@I9@", ds);
    expect(h.result.current.personSnapshots.current.has("@I9@")).toBe(false);
    expect(changed(h).people.sort()).toEqual(["@I1@", "@I9@"]);
  });

  it("reconcile clears a record changed back, keeps a loaded record deleted, forgets a new one deleted", () => {
    const ds = load();
    const h = mount(ds);
    const p = setFirstValue(ds, "individual", "@I1@", "Janez /Kranjc/");
    push(h, [p], ds);
    ds.individuals.get("@I1@")!.raw.children[0].value = "Janez /Novak/"; // edited back by hand
    expect(h.result.current.reconcile("individual", "@I1@", ds)).toBe(false);
    expect(changed(h).people).toEqual([]);

    applyRecordPatches(ds, [{ type: "individual", id: "@I2@", before: cloneNode(ds.individuals.get("@I2@")!.raw), after: null }], "redo");
    expect(h.result.current.reconcile("individual", "@I2@", ds)).toBe(true);
    expect(changed(h).people).toEqual(["@I2@"]);

    const add = addPerson(ds, "@I9@");
    push(h, [add], ds);
    expect(changed(h).people).toContain("@I9@");
    applyRecordPatches(ds, [add], "undo");
    expect(h.result.current.reconcile("individual", "@I9@", ds)).toBe(false);
    expect(changed(h).people).toEqual(["@I2@"]);

    // The record changed back gave up its snapshot along with its flag.
    expect(h.result.current.personSnapshots.current.has("@I1@")).toBe(false);
    // Still different from its snapshot: the flag stays.
    push(h, [setFirstValue(ds, "family", "@F1@", "@I2@")], ds);
    expect(h.result.current.reconcile("family", "@F1@", ds)).toBe(true);
    expect(changed(h).families).toEqual(["@F1@"]);
  });

  it("removeDirty drops the flag but keeps the snapshot undo needs", () => {
    const ds = load();
    const h = mount(ds);
    push(h, [setFirstValue(ds, "individual", "@I1@", "Janez /Kranjc/")], ds);
    h.result.current.removeDirty("individual", "@I1@");
    expect(changed(h).people).toEqual([]);
    expect(h.result.current.personSnapshots.current.has("@I1@")).toBe(true);
  });

  it("a save is the new baseline: clean, with the session's new people now counted as loaded", () => {
    const ds = load();
    const h = mount(ds);
    const add = addPerson(ds, "@I9@");
    push(h, [add, setFirstValue(ds, "individual", "@I1@", "Janez /Kranjc/")], ds);
    expect(h.result.current.loadedPersonIds.current.has("@I9@")).toBe(false);
    h.result.current.resetOnSave(ds);
    expect(changed(h)).toEqual({ people: [], families: [], records: [] });
    expect(h.result.current.loadedPersonIds.current.has("@I9@")).toBe(true);
    expect(h.result.current.personSnapshots.current.size).toBe(0);
    expect(h.result.current.isSubstantive("@I1@")).toBe(false);
    // The audit baseline is the saved file now.
    const base = h.result.current.ensureBaseline();
    expect(base.has("@I9@")).toBe(true);
    // An edit after the save snapshots the saved state, not the loaded one.
    push(h, [setFirstValue(ds, "individual", "@I1@", "Janez /Zupan/")], ds);
    expect(h.result.current.personSnapshots.current.get("@I1@")?.children[0].value).toBe("Janez /Kranjc/");
  });

  it("a fresh main resets everything, and prepareForLoad clears it before the parse lands", () => {
    const ds = load();
    const h = mount(ds);
    push(h, [setFirstValue(ds, "individual", "@I1@", "Janez /Kranjc/")], ds);
    h.result.current.prepareForLoad();
    expect(changed(h).people).toEqual([]);
    expect(h.result.current.loadedPersonIds.current.size).toBe(0);
    expect(h.result.current.ensureBaseline().size).toBe(0);
    const next = load(FILE.replace("Ana /Kos/", "Marija /Kos/"));
    h.result.current.resetOnLoad(next);
    expect([...h.result.current.loadedPersonIds.current].sort()).toEqual(["@I1@", "@I2@"]);
    expect(h.result.current.personSnapshots.current.size).toBe(0);
    expect(h.result.current.ensureBaseline().get("@I2@")?.label).toBe("Marija Kos");
  });

  it("takes the audit baseline lazily — at an idle moment, or the first edit, whichever comes first", () => {
    vi.useFakeTimers();
    const ds = load();
    const h = mount(ds);
    expect(h.result.current.baseline.current.size).toBe(0);
    vi.advanceTimersByTime(100);
    expect(h.result.current.baseline.current.size).toBeGreaterThan(0);
    // A later load's pass is not taken by an earlier load's timer.
    const other = load();
    h.result.current.resetOnLoad(other);
    expect(h.result.current.baseline.current.size).toBe(0);
    h.result.current.captureSnapshotsForPush([]);
    expect(h.result.current.baseline.current.get("@I1@")?.label).toBe("Janez Novak");
  });

  it("uses requestIdleCallback where the browser has one", () => {
    const idle = vi.fn((cb: () => void) => cb());
    vi.stubGlobal("requestIdleCallback", idle);
    try {
      const h = mount(load());
      expect(idle).toHaveBeenCalledTimes(1);
      expect(h.result.current.baseline.current.size).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("serialize → hydrate restores the tracking a cached session needs", () => {
    const ds = load();
    const h = mount(ds);
    const fam = setFirstValue(ds, "family", "@F1@", "@I2@");
    const src = { ...setFirstValue(ds, "record", "@S1@", "Mrliška knjiga"), owner: { kind: "individual" as const, id: "@I1@" } };
    push(h, [setFirstValue(ds, "individual", "@I1@", "Janez /Kranjc/"), addPerson(ds, "@I9@")], ds);
    push(h, markMechanical([fam]), ds);
    push(h, [src], ds);
    const saved = structuredClone(h.result.current.serialize());
    expect(saved.changedPersonIds.sort()).toEqual(["@I1@", "@I9@"]);

    // The reload re-parses the edited text, so the dataset already holds the edits.
    const restored = load(FILE);
    applyRecordPatches(restored, [fam], "redo");
    const h2 = renderHook(() => useDirtyTracking());
    h2.result.current.hydrate(saved, restored);
    expect(changed(h2)).toEqual({ people: saved.changedPersonIds, families: ["@F1@"], records: saved.changedRecordIds });
    expect(h2.result.current.isSubstantive("@I1@")).toBe(true);
    expect(h2.result.current.isSubstantive("@F1@")).toBe(false);
    expect(h2.result.current.familySnapshots.current.get("@F1@")?.children[0].value).toBe("@I1@");
    expect(h2.result.current.loadedPersonIds.current.has("@I9@")).toBe(false);
    // Undoing the family edit after the reload lands back on the snapshot: clean.
    undo(h2 as ReturnType<typeof mount>, restored, [fam]);
    expect(changed(h2).families).toEqual([]);
  });

  it("a cache from before the substantive split counts every changed record as substantive", () => {
    const h = renderHook(() => useDirtyTracking());
    h.result.current.hydrate(
      {
        loadedPersonIds: ["@I1@"], loadedFamilyIds: ["@F1@"],
        changedPersonIds: ["@I1@"], changedFamilyIds: ["@F1@"],
        personSnapshots: [], familySnapshots: [],
      },
      load(),
    );
    expect(h.result.current.isSubstantive("@I1@")).toBe(true);
    expect(h.result.current.isSubstantive("@F1@")).toBe(true);
    expect([...h.result.current.changedRecordIds]).toEqual([]);
    expect(h.result.current.recordSnapshots.current.size).toBe(0);
  });
});
