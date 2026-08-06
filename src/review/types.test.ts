import { describe, expect, it } from "vitest";
import {
  decisionKey,
  decisionStatusByMainId,
  findConfirmedDecision,
  parseDecisionKey,
  toggleDecisionStatus,
  type CandidateDecision,
} from "./types";

const confirmed = (fields: CandidateDecision["fields"] = {}): CandidateDecision => ({ status: "confirmed", fields });
const rejected = (): CandidateDecision => ({ status: "rejected", fields: {} });

describe("parseDecisionKey", () => {
  it("round-trips every key decisionKey can build", () => {
    for (const kind of ["individual", "family"] as const) {
      const key = decisionKey(kind, "@I12@", "@I99@");
      expect(parseDecisionKey(key)).toEqual({ kind, mainId: "@I12@", compareId: "@I99@" });
    }
  });

  it.each([
    ["empty", ""],
    ["too few parts", "individual:@I1@"],
    ["too many parts", "individual:@I1@:@I2@:extra"],
    ["unknown kind", "source:@I1@:@I2@"],
    ["blank main id", "individual::@I2@"],
    ["blank compare id", "individual:@I1@:"],
  ])("rejects a malformed key (%s)", (_case, key) => {
    expect(parseDecisionKey(key)).toBeUndefined();
  });
});

describe("toggleDecisionStatus", () => {
  it("sets the status on a pair that has none yet", () => {
    expect(toggleDecisionStatus(undefined, "confirmed")).toEqual({ status: "confirmed", fields: {} });
  });

  it("clears back to undecided when the status is pressed again", () => {
    expect(toggleDecisionStatus(confirmed(), "confirmed").status).toBe("undecided");
  });

  it("switches straight between two decided statuses", () => {
    expect(toggleDecisionStatus(rejected(), "confirmed").status).toBe("confirmed");
  });

  // A child is ticked in the compare panel while the match is still
  // undecided; confirming afterwards must not throw the tick away.
  it("keeps ticked children and dismissed events across a status change", () => {
    const before: CandidateDecision = {
      status: "undecided",
      fields: { surname: "incoming" },
      takenChildren: ["@P4@"],
      rejectedEvents: ["BIRT:1"],
    };
    expect(toggleDecisionStatus(before, "confirmed")).toEqual({
      status: "confirmed",
      fields: { surname: "incoming" },
      takenChildren: ["@P4@"],
      rejectedEvents: ["BIRT:1"],
    });
  });

  it("keeps them through confirm → undecided → confirm", () => {
    const before: CandidateDecision = { status: "undecided", fields: {}, takenChildren: ["@P4@"] };
    const round = toggleDecisionStatus(
      toggleDecisionStatus(toggleDecisionStatus(before, "confirmed"), "confirmed"),
      "confirmed",
    );
    expect(round).toEqual({ status: "confirmed", fields: {}, takenChildren: ["@P4@"] });
  });
});

describe("decisionStatusByMainId", () => {
  it("collapses to one status per main id, with confirmed winning", () => {
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@C1@"), rejected()],
      [decisionKey("individual", "@I1@", "@C2@"), confirmed()],
      [decisionKey("individual", "@I2@", "@C3@"), { status: "deferred", fields: {} }],
    ]);
    const map = decisionStatusByMainId(decisions);
    expect(map.get("@I1@")).toBe("confirmed");
    expect(map.get("@I2@")).toBe("deferred");
  });

  it("skips undecided entries, family keys and malformed keys", () => {
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@C1@"), { status: "undecided", fields: {} }],
      [decisionKey("family", "@F1@", "@C2@"), confirmed()],
      ["nonsense", confirmed()],
    ]);
    expect(decisionStatusByMainId(decisions).size).toBe(0);
  });

  it("returns an empty map for undefined decisions", () => {
    expect(decisionStatusByMainId(undefined).size).toBe(0);
  });
});

describe("findConfirmedDecision", () => {
  it("finds the confirmed entry for a main id, ignoring other statuses and people", () => {
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@C1@"), rejected()],
      [decisionKey("individual", "@I2@", "@C2@"), confirmed()],
    ]);
    const found = findConfirmedDecision(decisions, "@I2@");
    expect(found?.key).toBe(decisionKey("individual", "@I2@", "@C2@"));
    expect(found?.compareId).toBe("@C2@");
    expect(findConfirmedDecision(decisions, "@I1@")).toBeUndefined();
  });

  it("ignores family-kind and malformed keys", () => {
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("family", "@I1@", "@C1@"), confirmed()],
      ["individual:@I1@", confirmed()],
    ]);
    expect(findConfirmedDecision(decisions, "@I1@")).toBeUndefined();
  });

  // The reason this helper exists: a main id can carry several confirmed
  // entries, and every caller must pick the same one or the merge preview and
  // the edit handlers end up pointed at different incoming records.
  describe("when one main id carries several confirmed entries", () => {
    const decisions = new Map<string, CandidateDecision>([
      [decisionKey("individual", "@I1@", "@GONE@"), confirmed({ a: "main" })],
      [decisionKey("individual", "@I1@", "@LIVE@"), confirmed({ b: "incoming" })],
    ]);
    const resolve = (id: string) => (id === "@LIVE@" ? { id } : undefined);

    it("prefers the entry whose incoming record still resolves", () => {
      const found = findConfirmedDecision(decisions, "@I1@", resolve);
      expect(found?.compareId).toBe("@LIVE@");
      expect(found?.decision.fields).toEqual({ b: "incoming" });
    });

    it("is stable across repeated calls, so preview and handlers agree", () => {
      const a = findConfirmedDecision(decisions, "@I1@", resolve);
      const b = findConfirmedDecision(decisions, "@I1@", resolve);
      expect(a?.key).toBe(b?.key);
    });

    it("falls back to the first confirmed entry when none resolve", () => {
      const found = findConfirmedDecision(decisions, "@I1@", () => undefined);
      expect(found?.compareId).toBe("@GONE@");
    });

    it("takes the first entry when no resolver is supplied", () => {
      expect(findConfirmedDecision(decisions, "@I1@")?.compareId).toBe("@GONE@");
    });
  });

  it("returns undefined for undefined decisions", () => {
    expect(findConfirmedDecision(undefined, "@I1@")).toBeUndefined();
  });
});
