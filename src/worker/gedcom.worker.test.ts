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
/** Let the table importer finish: a CSV or spreadsheet is read asynchronously
 *  (a workbook has to be inflated), so `parseCsv` answers after a turn. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
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

  it("a compare that fails to normalize against a new main fails the compare slot, not the main", async () => {
    const send = await freshWorker();
    send({ type: "parse", role: "compare", fileName: "b.ged", buffer: enc(COMPARE) });
    // Break the kept compare so its re-normalization throws once the main lands.
    const parsedCompare = posted[0];
    if (parsedCompare.type !== "parsed") throw new Error("expected parsed");
    Object.defineProperty(parsedCompare.dataset, "records", { get() { throw new Error("boom"); } });
    send({ type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    expect(types()).toEqual(["parsed", "parsed", "error"]);
    expect(posted[1]).toMatchObject({ type: "parsed", role: "main", fileName: "a.ged" });
    expect(posted[2]).toMatchObject({ type: "error", role: "compare", fileName: "b.ged" });
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

  it("consolidates incoming duplicates, re-emits the cleaned compare, then matches", async () => {
    // Two incoming records that are the same person (both pair with the one
    // main Janez) are merged into one before the result is announced. The
    // whole session then reads from the consolidated compare, so the exact
    // sequence — parsed(compare) again, with the consolidation counted in its
    // report, and only then matched — is the contract App.tsx builds on.
    const compareDup = wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 2 FEB 1850\n" +
        "0 @P2@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 2 FEB 1850\n1 DEAT\n2 DATE 1 MAR 1900\n",
    );
    const send = await freshWorker();
    send({ type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    send({ type: "parse", role: "compare", fileName: "b.ged", buffer: enc(compareDup) });
    expect(types()).toEqual(["parsed", "parsed", "matching", "parsed", "matched"]);
    const reEmit = posted[3];
    if (reEmit.type !== "parsed") throw new Error("expected a parsed re-emit");
    expect(reEmit.report?.consolidatedDuplicates).toBe(1);
    // One survivor carrying the merged data; no pair references the merged-away id.
    const pairs = lastMatched()!.individuals;
    expect(pairs).toHaveLength(1);
    const survivor = pairs[0].compareId;
    expect(reEmit.dataset.individuals.has(survivor)).toBe(true);
    expect(reEmit.dataset.individuals.size).toBe(1);
    // The merged-away record's own facts travelled onto the survivor.
    expect(reEmit.dataset.individuals.get(survivor)!.events.some((e) => e.tag === "DEAT")).toBe(true);
  });

  it("a parish-register index CSV goes through the ordinary matching engine", async () => {
    // The matches CSV names its own main-side person and is resolved pair by
    // pair; a parish index is a whole register and says nothing about the
    // reader's tree, so it must reach `matchDatasets` exactly as a GEDCOM
    // compare file does — which is what makes its people, and the parents its
    // notes name, candidates at all.
    const index =
      "zp. št.;župnija;datum poroke;naslov;ime ženina;priimek ženina;ime neveste;priimek neveste;opombe\r\n" +
      '1;Trbovlje;1875-04-11;Dol 3;Janez;Novak;Marija;Kralj;"Ženin: 25 let; starša Jakob Novak in Ana Kos."\r\n';
    const send = await freshWorker();
    send({ type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    posted = [];
    send({ type: "parseCsv", fileName: "Indeks P Trbovlje.csv", buffer: enc(index) });
    await flush();
    expect(types()).toEqual(["parsed", "matching", "matched"]);
    const compare = posted[0];
    if (compare.type !== "parsed") throw new Error("expected the compare slot to parse");
    // Groom, bride and the two parents his note names.
    expect(compare.dataset.individuals.size).toBe(4);
    expect(lastMatched()?.individuals[0]).toMatchObject({ mainId: "@I1@" });
  });

  it("the incoming file chosen last is the one that lands", async () => {
    // Reading a table is asynchronous, and the app only tears the worker down
    // when a match is in flight — so two files picked in quick succession are
    // both in flight here. Whichever finishes reading first, the slot must end
    // up holding the one the reader chose last.
    const index = (parish: string, groom: string) =>
      "zp. št.;župnija;datum poroke;naslov;ime ženina;priimek ženina;ime neveste;priimek neveste;opombe\r\n" +
      `1;${parish};1875-04-11;Dol 3;${groom};Novak;Marija;Kralj;\r\n`;
    const send = await freshWorker();
    send({ type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    posted = [];
    send({ type: "parseCsv", fileName: "first.csv", buffer: enc(index("Trbovlje", "Janez")) });
    send({ type: "parseCsv", fileName: "second.csv", buffer: enc(index("Kranj", "Peter")) });
    await flush();
    const parsed = posted.filter((m) => m.type === "parsed");
    expect(parsed).toHaveLength(1);
    if (parsed[0].type !== "parsed") throw new Error("expected a parsed compare");
    expect(parsed[0].fileName).toBe("second.csv");
    const names = [...parsed[0].dataset.individuals.values()].map((i) => i.names[0]?.given);
    expect(names).toContain("Peter");
    expect(names).not.toContain("Janez");
  });

  it("an unreadable matches CSV fails the compare slot, not the worker", async () => {
    const send = await freshWorker();
    send({ type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    posted = [];
    send({ type: "parseCsv", fileName: "junk.csv", buffer: enc("this;is;no;matches;csv\n1;2;3;4;5\n") });
    await flush();
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
