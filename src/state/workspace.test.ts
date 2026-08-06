import { describe, expect, it } from "vitest";
import type { Dataset } from "../gedcom/types";
import { decisionKey, type CandidateDecision } from "../review/types";
import type { MatchResult } from "../match/types";
import {
  initialWorkspace,
  workspaceReducer,
  type LoadedFile,
  type WorkspaceAction,
  type WorkspaceState,
} from "./workspace";

// Minimal stand-ins — the reducer only stores/positions these, never inspects
// their internals, so shape fidelity beyond identity doesn't matter here.
const file = (fileName: string): LoadedFile => ({ fileName, dataset: {} as Dataset });
const result = (): MatchResult => ({ individuals: [] });
const decision = (status: CandidateDecision["status"] = "confirmed"): CandidateDecision => ({ status, fields: {} });

const reduce = (state: WorkspaceState, ...actions: WorkspaceAction[]) =>
  actions.reduce(workspaceReducer, state);

describe("workspaceReducer — slots", () => {
  it("moves a slot through loading → loaded and preserves the other slot", () => {
    const s1 = workspaceReducer(initialWorkspace, { type: "slotLoading", role: "main", fileName: "a.ged" });
    expect(s1.main).toEqual({ status: "loading", fileName: "a.ged" });
    expect(s1.compare).toEqual({ status: "empty" });

    const f = file("a.ged");
    const s2 = workspaceReducer(s1, { type: "slotLoaded", role: "main", file: f });
    expect(s2.main).toEqual({ status: "loaded", file: f });
  });

  it("records lastMainFile only for the main slot", () => {
    const fm = file("m.ged");
    const fc = file("c.ged");
    const s = reduce(
      initialWorkspace,
      { type: "slotLoaded", role: "main", file: fm },
      { type: "slotLoaded", role: "compare", file: fc },
    );
    expect(s.lastMainFile).toBe(fm); // not overwritten by the compare load
  });

  it("bumps mainLoadGen on every main load, but never on compare loads", () => {
    const s1 = workspaceReducer(initialWorkspace, { type: "slotLoaded", role: "main", file: file("a.ged") });
    expect(s1.mainLoadGen).toBe(1);
    // A compare load must not remount the Edit/Tools views.
    const s2 = workspaceReducer(s1, { type: "slotLoaded", role: "compare", file: file("c.ged") });
    expect(s2.mainLoadGen).toBe(1);
    // Replacing the main (same or different file) is a new generation — Edit's
    // per-person input state must not survive into a dataset that may reuse
    // the same xrefs for different people.
    const s3 = reduce(
      s2,
      { type: "slotLoading", role: "main", fileName: "b.ged" },
      { type: "slotLoaded", role: "main", file: file("b.ged") },
    );
    expect(s3.mainLoadGen).toBe(2);
  });

  it("keeps counting mainLoadGen across a reset (generation keys never repeat)", () => {
    const loaded = workspaceReducer(initialWorkspace, { type: "slotLoaded", role: "main", file: file("a.ged") });
    const afterReset = workspaceReducer(loaded, { type: "reset" });
    expect(afterReset.mainLoadGen).toBe(1);
    const reloaded = workspaceReducer(afterReset, { type: "slotLoaded", role: "main", file: file("b.ged") });
    expect(reloaded.mainLoadGen).toBe(2);
  });

  it("keeps lastMainFile while the main reloads (loading state)", () => {
    const fm = file("m.ged");
    const s = reduce(
      initialWorkspace,
      { type: "slotLoaded", role: "main", file: fm },
      { type: "slotLoading", role: "main", fileName: "m2.ged" },
    );
    expect(s.main).toEqual({ status: "loading", fileName: "m2.ged" });
    expect(s.lastMainFile).toBe(fm);
  });

  // A save can give a file a better name than it was created with; the open
  // file follows it without counting as a new load.
  it("renames the main in both slots, keeping the dataset and generation", () => {
    const fm = file("new-tree.ged");
    const loaded = workspaceReducer(initialWorkspace, { type: "slotLoaded", role: "main", file: fm });
    const s = workspaceReducer(loaded, { type: "mainRenamed", fileName: "Novak.ged" });

    expect(s.lastMainFile?.fileName).toBe("Novak.ged");
    expect(s.main).toEqual({ status: "loaded", file: s.lastMainFile });
    expect(s.lastMainFile?.dataset).toBe(fm.dataset); // same file, only relabelled
    expect(s.mainLoadGen).toBe(loaded.mainLoadGen); // …so nothing keyed on it remounts
  });

  it("ignores a rename that changes nothing, or with no main loaded", () => {
    const loaded = workspaceReducer(initialWorkspace, { type: "slotLoaded", role: "main", file: file("a.ged") });
    expect(workspaceReducer(loaded, { type: "mainRenamed", fileName: "a.ged" })).toBe(loaded);
    expect(workspaceReducer(initialWorkspace, { type: "mainRenamed", fileName: "a.ged" })).toBe(initialWorkspace);
  });

  it("leaves a main mid-reload under its own name", () => {
    const s = reduce(
      initialWorkspace,
      { type: "slotLoaded", role: "main", file: file("old.ged") },
      { type: "slotLoading", role: "main", fileName: "incoming.ged" },
      { type: "mainRenamed", fileName: "Novak.ged" },
    );
    expect(s.main).toEqual({ status: "loading", fileName: "incoming.ged" });
    expect(s.lastMainFile?.fileName).toBe("Novak.ged");
  });

  it("handles error and cleared", () => {
    const s1 = workspaceReducer(initialWorkspace, {
      type: "slotError", role: "compare", fileName: "bad.ged", message: "boom",
    });
    expect(s1.compare).toEqual({ status: "error", fileName: "bad.ged", message: "boom" });
    const s2 = workspaceReducer(s1, { type: "slotCleared", role: "compare" });
    expect(s2.compare).toEqual({ status: "empty" });
  });
});

describe("workspaceReducer — matching", () => {
  it("toggles matching around a matched result", () => {
    const started = workspaceReducer(initialWorkspace, { type: "matchingStarted" });
    expect(started.matching).toBe(true);
    const r = result();
    const done = workspaceReducer(started, { type: "matched", result: r });
    expect(done.matching).toBe(false);
    expect(done.matches).toBe(r);
  });

  it("matchingStarted is a no-op when already matching (stable reference)", () => {
    const started = workspaceReducer(initialWorkspace, { type: "matchingStarted" });
    expect(workspaceReducer(started, { type: "matchingStarted" })).toBe(started);
  });

  it("matchesCleared drops results and is a no-op when already null", () => {
    const done = workspaceReducer(initialWorkspace, { type: "matched", result: result() });
    const cleared = workspaceReducer(done, { type: "matchesCleared" });
    expect(cleared.matches).toBeNull();
    expect(workspaceReducer(cleared, { type: "matchesCleared" })).toBe(cleared);
  });
});

describe("workspaceReducer — decisions & branches", () => {
  const key = decisionKey("individual", "@I1@", "@I9@");

  it("decisionsSet replaces the map as a fresh copy, without aliasing", () => {
    const src = new Map([[key, decision("confirmed")]]);
    const s1 = workspaceReducer(initialWorkspace, { type: "decisionsSet", decisions: src });
    expect(s1.decisions.get(key)?.status).toBe("confirmed");
    expect(s1.decisions).not.toBe(src); // copied, not aliased
    expect(initialWorkspace.decisions.size).toBe(0); // original untouched

    const s2 = workspaceReducer(s1, { type: "decisionsSet", decisions: new Map([[key, decision("rejected")]]) });
    expect(s2.decisions.get(key)?.status).toBe("rejected");
    expect(s1.decisions.get(key)?.status).toBe("confirmed"); // s1 unchanged
  });

  it("importBranchesSet replaces the set as a fresh copy", () => {
    const branches = new Set(["b1", "b2"]);
    const s = workspaceReducer(initialWorkspace, { type: "importBranchesSet", branches });
    expect([...s.importBranches]).toEqual(["b1", "b2"]);
    expect(s.importBranches).not.toBe(branches);
  });

  it("confirmedDecisionsCleared drops only confirmed entries, always as a fresh map", () => {
    const s1 = workspaceReducer(initialWorkspace, {
      type: "decisionsSet",
      decisions: new Map([
        ["a", decision("confirmed")],
        ["b", decision("rejected")],
        ["c", decision("confirmed")],
      ]),
    });
    const s2 = workspaceReducer(s1, { type: "confirmedDecisionsCleared" });
    expect([...s2.decisions.keys()]).toEqual(["b"]); // confirmed a & c dropped
    // Always a new map (even with no confirmed), for the identity-based bump.
    const s3 = workspaceReducer(s2, { type: "confirmedDecisionsCleared" });
    expect(s3.decisions).not.toBe(s2.decisions);
  });

  it("decisionsCleared / importBranchesCleared empty their collections (no-op when already empty)", () => {
    const s1 = workspaceReducer(initialWorkspace, {
      type: "decisionsSet", decisions: new Map([[key, decision()]]),
    });
    const s2 = reduce(s1, { type: "decisionsCleared" }, { type: "importBranchesCleared" });
    expect(s2.decisions.size).toBe(0);
    expect(workspaceReducer(s2, { type: "decisionsCleared" })).toBe(s2);
    expect(workspaceReducer(s2, { type: "importBranchesCleared" })).toBe(s2);
  });
});

describe("workspaceReducer — start & reset", () => {
  it("sets the start person", () => {
    expect(workspaceReducer(initialWorkspace, { type: "setStart", id: "@I5@" }).startId).toBe("@I5@");
    expect(workspaceReducer(initialWorkspace, { type: "setStart", id: undefined }).startId).toBeUndefined();
  });

  it("reset returns a clean workspace with fresh empty collections", () => {
    const dirty = reduce(
      initialWorkspace,
      { type: "slotLoaded", role: "main", file: file("m.ged") },
      { type: "matched", result: result() },
      { type: "decisionsSet", decisions: new Map([[decisionKey("individual", "@I1@", "@I2@"), decision()]]) },
      { type: "setStart", id: "@I1@" },
    );
    const s = workspaceReducer(dirty, { type: "reset" });
    expect(s.main).toEqual({ status: "empty" });
    expect(s.matches).toBeNull();
    expect(s.decisions.size).toBe(0);
    expect(s.importBranches.size).toBe(0);
    expect(s.startId).toBeUndefined();
    expect(s.decisions).not.toBe(dirty.decisions);
  });
});
