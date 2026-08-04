import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerRequest, WorkerResponse } from "./messages";

/**
 * Integration tests for the worker's parse → normalize → match pipeline —
 * the message protocol App.tsx builds its slot state machine on. The worker
 * module keeps its own state (mainDataset / compareRaw / lastResult), so each
 * test imports a fresh copy via vi.resetModules() and drives it through a
 * stubbed `self`, asserting on the exact message sequences: the app's
 * "any side can load in any order" behaviour lives or dies by them.
 */

const enc = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

// Day-exact same person on both sides, so the engine always pairs them.
const MAIN = wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 2 FEB 1850\n");
const MAIN2 = wrap("0 @I2@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 2 FEB 1850\n");
const COMPARE = wrap("0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 2 FEB 1850\n");

let posted: WorkerResponse[];

/** Import a fresh worker module wired to a stubbed DedicatedWorkerGlobalScope. */
async function freshWorker(): Promise<(req: WorkerRequest) => void> {
  posted = [];
  const scope = {
    onmessage: null as ((e: MessageEvent<WorkerRequest>) => void) | null,
    postMessage: (msg: WorkerResponse) => posted.push(msg),
  };
  vi.stubGlobal("self", scope);
  await import("./gedcom.worker");
  return (req) => scope.onmessage!({ data: req } as MessageEvent<WorkerRequest>);
}

const types = () => posted.map((m) => m.type);
const lastMatched = () => {
  const m = [...posted].reverse().find((x) => x.type === "matched");
  return m?.type === "matched" ? m.result : undefined;
};

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("gedcom.worker pipeline", () => {
  it("main then compare: parsed twice, then one matching/matched cycle", async () => {
    const send = await freshWorker();
    send({ type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    expect(types()).toEqual(["parsed"]);
    send({ type: "parse", role: "compare", fileName: "b.ged", buffer: enc(COMPARE) });
    expect(types()).toEqual(["parsed", "parsed", "matching", "matched"]);
    expect(lastMatched()?.individuals).toMatchObject([{ mainId: "@I1@", compareId: "@P1@" }]);
  });

  it("compare before main: the kept compare re-emits normalized and matches", async () => {
    const send = await freshWorker();
    send({ type: "parse", role: "compare", fileName: "b.ged", buffer: enc(COMPARE) });
    // No main yet: the compare parses raw, and nothing matches.
    expect(types()).toEqual(["parsed"]);
    send({ type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    // The main's arrival re-emits the compare (now normalized to its profile)
    // and runs the match — load order must not change the outcome.
    expect(types()).toEqual(["parsed", "parsed", "parsed", "matching", "matched"]);
    expect(lastMatched()?.individuals).toMatchObject([{ mainId: "@I1@", compareId: "@P1@" }]);
  });

  it("replacing the main re-matches the kept compare against the new file", async () => {
    const send = await freshWorker();
    send({ type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    send({ type: "parse", role: "compare", fileName: "b.ged", buffer: enc(COMPARE) });
    posted = [];
    send({ type: "parse", role: "main", fileName: "a2.ged", buffer: enc(MAIN2) });
    expect(types()).toEqual(["parsed", "parsed", "matching", "matched"]);
    // The result references the new main's xrefs, not the replaced file's.
    expect(lastMatched()?.individuals).toMatchObject([{ mainId: "@I2@", compareId: "@P1@" }]);
  });

  it("a silent main re-feed rebuilds state without re-announcing the main", async () => {
    const send = await freshWorker();
    send({ type: "parse", role: "compare", fileName: "b.ged", buffer: enc(COMPARE) });
    posted = [];
    // The hard-abort recovery path: a fresh worker is fed the kept main
    // silently so the main thread's slot (and edit tracking) stay untouched.
    send({ type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN), silent: true });
    expect(types()).toEqual(["parsed", "matching", "matched"]); // compare re-emit only, no parsed(main)
    expect(posted[0]).toMatchObject({ type: "parsed", role: "compare" });
  });

  it("setStart re-ranks the last result as a fresh matching/matched cycle", async () => {
    const send = await freshWorker();
    send({ type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    send({ type: "parse", role: "compare", fileName: "b.ged", buffer: enc(COMPARE) });
    posted = [];
    send({ type: "setStart", id: "@I1@" });
    expect(types()).toEqual(["matching", "matched"]);
    posted = [];
    // Clearing the start person re-ranks back too.
    send({ type: "setStart", id: "" });
    expect(types()).toEqual(["matching", "matched"]);
  });

  it("clearCompare forgets the incoming file so a main reload matches nothing", async () => {
    const send = await freshWorker();
    send({ type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    send({ type: "parse", role: "compare", fileName: "b.ged", buffer: enc(COMPARE) });
    posted = [];
    send({ type: "clearCompare" });
    expect(types()).toEqual([]); // no response by contract
    send({ type: "parse", role: "main", fileName: "a2.ged", buffer: enc(MAIN2) });
    // Only the new main parses — the old compare must not resurrect.
    expect(types()).toEqual(["parsed"]);
  });

  it("an unreadable matches CSV fails the compare slot, not the worker", async () => {
    const send = await freshWorker();
    send({ type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    posted = [];
    send({ type: "parseCsv", fileName: "junk.csv", buffer: enc("this;is;no;matches;csv\n1;2;3;4;5\n") });
    expect(types()).toEqual(["error"]);
    expect(posted[0]).toMatchObject({ type: "error", role: "compare", fileName: "junk.csv" });
    // The worker survives: the main is still loaded and a real compare works.
    send({ type: "parse", role: "compare", fileName: "b.ged", buffer: enc(COMPARE) });
    expect(types()).toEqual(["error", "parsed", "matching", "matched"]);
  });

  it("a match-pipeline throw is matchFailed, never a parse error", async () => {
    vi.doMock("../match/engine", () => ({
      matchDatasets: () => {
        throw new Error("boom");
      },
    }));
    try {
      const send = await freshWorker();
      send({ type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
      send({ type: "parse", role: "compare", fileName: "b.ged", buffer: enc(COMPARE) });
      // Both slots parsed fine; only the match failed. An `error` here would
      // make the app fail a healthy slot and evict its cached file.
      expect(types()).toEqual(["parsed", "parsed", "matching", "matchFailed"]);
      expect(posted[3]).toMatchObject({ type: "matchFailed", message: "boom" });
    } finally {
      vi.doUnmock("../match/engine");
    }
  });
});
