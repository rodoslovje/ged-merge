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
    const s1 = workspaceReducer(initialWorkspace, { type: "slotLoading", role: "master", fileName: "a.ged" });
    expect(s1.master).toEqual({ status: "loading", fileName: "a.ged" });
    expect(s1.compare).toEqual({ status: "empty" });

    const f = file("a.ged");
    const s2 = workspaceReducer(s1, { type: "slotLoaded", role: "master", file: f });
    expect(s2.master).toEqual({ status: "loaded", file: f });
  });

  it("records lastMasterFile only for the master slot", () => {
    const fm = file("m.ged");
    const fc = file("c.ged");
    const s = reduce(
      initialWorkspace,
      { type: "slotLoaded", role: "master", file: fm },
      { type: "slotLoaded", role: "compare", file: fc },
    );
    expect(s.lastMasterFile).toBe(fm); // not overwritten by the compare load
  });

  it("keeps lastMasterFile while the master reloads (loading state)", () => {
    const fm = file("m.ged");
    const s = reduce(
      initialWorkspace,
      { type: "slotLoaded", role: "master", file: fm },
      { type: "slotLoading", role: "master", fileName: "m2.ged" },
    );
    expect(s.master).toEqual({ status: "loading", fileName: "m2.ged" });
    expect(s.lastMasterFile).toBe(fm);
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

  it("decide adds/updates a decision without mutating the previous map", () => {
    const s1 = workspaceReducer(initialWorkspace, { type: "decide", key, decision: decision("confirmed") });
    expect(s1.decisions.get(key)?.status).toBe("confirmed");
    expect(initialWorkspace.decisions.size).toBe(0); // original untouched
    expect(s1.decisions).not.toBe(initialWorkspace.decisions);

    const s2 = workspaceReducer(s1, { type: "decide", key, decision: decision("rejected") });
    expect(s2.decisions.get(key)?.status).toBe("rejected");
    expect(s1.decisions.get(key)?.status).toBe("confirmed"); // s1 unchanged
  });

  it("undecide removes a key, and is a no-op (stable ref) when absent", () => {
    const s1 = workspaceReducer(initialWorkspace, { type: "decide", key, decision: decision() });
    const s2 = workspaceReducer(s1, { type: "undecide", key });
    expect(s2.decisions.has(key)).toBe(false);
    expect(workspaceReducer(s2, { type: "undecide", key })).toBe(s2); // nothing to remove
  });

  it("restores decisions and branches from a session as fresh copies", () => {
    const src = new Map([[key, decision("deferred")]]);
    const branches = new Set(["b1", "b2"]);
    const s = reduce(
      initialWorkspace,
      { type: "decisionsRestored", decisions: src },
      { type: "importBranchesRestored", branches },
    );
    expect(s.decisions.get(key)?.status).toBe("deferred");
    expect(s.decisions).not.toBe(src); // copied, not aliased
    expect([...s.importBranches]).toEqual(["b1", "b2"]);
    expect(s.importBranches).not.toBe(branches);
  });

  it("decisionsCleared empties the map (and is a no-op when already empty)", () => {
    const s1 = workspaceReducer(initialWorkspace, { type: "decide", key, decision: decision() });
    const s2 = workspaceReducer(s1, { type: "decisionsCleared" });
    expect(s2.decisions.size).toBe(0);
    expect(workspaceReducer(s2, { type: "decisionsCleared" })).toBe(s2);
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
      { type: "slotLoaded", role: "master", file: file("m.ged") },
      { type: "matched", result: result() },
      { type: "decide", key: decisionKey("individual", "@I1@", "@I2@"), decision: decision() },
      { type: "setStart", id: "@I1@" },
    );
    const s = workspaceReducer(dirty, { type: "reset" });
    expect(s.master).toEqual({ status: "empty" });
    expect(s.matches).toBeNull();
    expect(s.decisions.size).toBe(0);
    expect(s.importBranches.size).toBe(0);
    expect(s.startId).toBeUndefined();
    expect(s.decisions).not.toBe(dirty.decisions);
  });
});
