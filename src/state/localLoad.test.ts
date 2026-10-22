import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { downloadOptions, serializeGedcom } from "../gedcom/serialize";
import type { Dataset } from "../gedcom/types";
import { forestDiff } from "../normalize/forestDiff.testutil";
import { applyFormatOverrides } from "../normalize/formatOverrides";
import { normalizeDataset } from "../normalize/normalize";
import { diffNormalized } from "../normalize/normPatch";
import { collectLayoutValues, inferMainProfile } from "../normalize/profile";
import type { MainProfile } from "../normalize/types";
import type { WorkerRequest, WorkerResponse } from "../worker/messages";
import { LocalLoads } from "./localLoad";

type Parsed = Extract<WorkerResponse, { type: "parsed" }>;

const enc = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
// The main writes dates as DD.MM.YYYY; the compare writes them the GEDCOM way,
// so normalizing against the main's profile visibly reshapes the compare.
const MAIN = wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 02.02.1850\n2 PLAC Kranj\n");
const COMPARE = wrap(
  "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 2 FEB 1850\n" +
    "0 @P2@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 2 FEB 1850\n1 DEAT\n2 DATE 1 MAR 1900\n",
);

const dsOf = (text: string): Dataset => buildDataset(parseGedcom(enc(text)));
const profileOf = (text: string) => applyFormatOverrides(inferMainProfile(dsOf(text)), undefined);
const parsed = (over: Partial<Parsed> & Pick<Parsed, "role" | "fileName">): Parsed => ({ type: "parsed", ...over });
/** What the worker announces for a compare it normalized against `profile`. */
function normalizedBy(text: string, profile: MainProfile): Partial<Parsed> {
  const raw = dsOf(text);
  const { report, dataset } = normalizeDataset(raw, profile, collectLayoutValues(raw).dateValues);
  return { profile, report, normalized: diffNormalized(raw.records, dataset.records) };
}
/** The same announcement with no edits to replay. */
function withoutEdits(text: string, profile: MainProfile): Partial<Parsed> {
  const { normalized: _, ...rest } = normalizedBy(text, profile);
  return rest;
}
const birthDate = (ds: Dataset, id: string) => ds.individuals.get(id)?.events.find((e) => e.tag === "BIRT")?.date?.raw;

/** A worker stand-in that records what it was sent and whether a buffer was transferred. */
function stub() {
  const sent: Array<{ msg: WorkerRequest; transfer: Transferable[] | undefined }> = [];
  return { sent, post: (msg: WorkerRequest, transfer?: Transferable[]) => void sent.push({ msg, transfer }) };
}

describe("LocalLoads", () => {
  it("builds the main from a copy of the bytes, posting the original on", () => {
    const local = new LocalLoads();
    const w = stub();
    const buffer = enc(MAIN);
    local.feed(w.post, { type: "parse", role: "main", fileName: "a.ged", buffer }, [buffer]);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].transfer).toEqual([buffer]);
    const ds = local.resolve(parsed({ role: "main", fileName: "a.ged", profile: profileOf(MAIN) }));
    expect(ds?.individuals.has("@I1@")).toBe(true);
  });

  it("a silent re-feed and a table load only pass through", () => {
    const local = new LocalLoads();
    const w = stub();
    local.feed(w.post, { type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN), silent: true });
    local.feed(w.post, { type: "parseCsv", fileName: "t.csv", buffer: enc("x") });
    expect(w.sent.map((s) => s.msg.type)).toEqual(["parse", "parseCsv"]);
    // Nothing was built: a main announced now has no local copy.
    expect(local.resolve(parsed({ role: "main", fileName: "a.ged" }))).toBeUndefined();
  });

  it("a table compare's dataset comes from the message itself", () => {
    const local = new LocalLoads();
    const table = dsOf(COMPARE);
    expect(local.resolve(parsed({ role: "compare", fileName: "t.csv", dataset: table }))).toBe(table);
  });

  it("normalizes a compare against the profile the main announced", () => {
    const local = new LocalLoads();
    const w = stub();
    local.feed(w.post, { type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    local.resolve(parsed({ role: "main", fileName: "a.ged", profile: profileOf(MAIN) }));
    local.feed(w.post, { type: "parse", role: "compare", fileName: "b.ged", buffer: enc(COMPARE) });
    const compare = local.resolve(parsed({ role: "compare", fileName: "b.ged", ...normalizedBy(COMPARE, profileOf(MAIN)) }));
    expect(birthDate(compare!, "@P1@")).toBe("02.02.1850"); // reshaped to the main's DD.MM.YYYY
  });

  it("normalizes here when the worker's announcement carries no edits to replay", () => {
    const local = new LocalLoads();
    const w = stub();
    local.feed(w.post, { type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    local.resolve(parsed({ role: "main", fileName: "a.ged", profile: profileOf(MAIN) }));
    local.feed(w.post, { type: "parse", role: "compare", fileName: "b.ged", buffer: enc(COMPARE) });
    const compare = local.resolve(parsed({ role: "compare", fileName: "b.ged", ...withoutEdits(COMPARE, profileOf(MAIN)) }));
    expect(birthDate(compare!, "@P1@")).toBe("02.02.1850");
  });

  it("edits made against another forest are refused, and the compare normalized here", () => {
    const local = new LocalLoads();
    const w = stub();
    local.feed(w.post, { type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    local.resolve(parsed({ role: "main", fileName: "a.ged", profile: profileOf(MAIN) }));
    local.feed(w.post, { type: "parse", role: "compare", fileName: "b.ged", buffer: enc(COMPARE) });
    const other = wrap("0 @P1@ INDI\n1 BIRT\n2 DATE 2 FEB 1850\n");
    const compare = local.resolve(parsed({ role: "compare", fileName: "b.ged", ...normalizedBy(other, profileOf(MAIN)) }));
    expect(birthDate(compare!, "@P1@")).toBe("02.02.1850");
    expect(compare!.individuals.get("@P2@")?.events.some((e) => e.tag === "DEAT")).toBe(true);
  });

  it("a compare loaded before any main is announced raw, then normalized once the main lands", () => {
    const local = new LocalLoads();
    const w = stub();
    local.feed(w.post, { type: "parse", role: "compare", fileName: "b.ged", buffer: enc(COMPARE) });
    const raw = local.resolve(parsed({ role: "compare", fileName: "b.ged" }));
    expect(birthDate(raw!, "@P1@")).toBe("2 FEB 1850");
    local.feed(w.post, { type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    local.resolve(parsed({ role: "main", fileName: "a.ged", profile: profileOf(MAIN) }));
    // The worker re-announces the compare; this side replays it on a new parse.
    const normalized = local.resolve(parsed({ role: "compare", fileName: "b.ged", ...normalizedBy(COMPARE, profileOf(MAIN)) }));
    expect(birthDate(normalized!, "@P1@")).toBe("02.02.1850");
  });

  it("a later main re-normalizes the compare from its bytes, after the raw copy was dropped", () => {
    const local = new LocalLoads();
    const w = stub();
    local.feed(w.post, { type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    local.resolve(parsed({ role: "main", fileName: "a.ged", profile: profileOf(MAIN) }));
    local.feed(w.post, { type: "parse", role: "compare", fileName: "b.ged", buffer: enc(COMPARE) });
    const first = local.resolve(parsed({ role: "compare", fileName: "b.ged", ...normalizedBy(COMPARE, profileOf(MAIN)) }));
    expect(birthDate(first!, "@P1@")).toBe("02.02.1850");
    // A new main with the GEDCOM date style: the compare must read that way now.
    const main2 = wrap("0 @I2@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 2 FEB 1850\n2 PLAC Kranj\n");
    local.feed(w.post, { type: "parse", role: "main", fileName: "a2.ged", buffer: enc(main2) });
    local.resolve(parsed({ role: "main", fileName: "a2.ged", profile: profileOf(main2) }));
    const second = local.resolve(parsed({ role: "compare", fileName: "b.ged", ...normalizedBy(COMPARE, profileOf(main2)) }));
    expect(second).not.toBe(first);
    expect(birthDate(second!, "@P1@")).toBe("2 FEB 1850");
  });

  it("normalizes a compare against the profile its own announcement carries", () => {
    // A silent main re-feed (an override changed, an edited main re-sent)
    // posts no main `parsed`: the worker's profile moved, and the compare it
    // re-announces says so itself.
    const local = new LocalLoads();
    const w = stub();
    local.feed(w.post, { type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    local.resolve(parsed({ role: "main", fileName: "a.ged", profile: profileOf(MAIN) }));
    local.feed(w.post, { type: "parse", role: "compare", fileName: "b.ged", buffer: enc(COMPARE) });
    local.resolve(parsed({ role: "compare", fileName: "b.ged", ...normalizedBy(COMPARE, profileOf(MAIN)) }));
    const gedcomStyle = wrap("0 @I2@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 2 FEB 1850\n2 PLAC Kranj\n");
    const again = local.resolve(parsed({ role: "compare", fileName: "b.ged", ...withoutEdits(COMPARE, profileOf(gedcomStyle)) }));
    expect(birthDate(again!, "@P1@")).toBe("2 FEB 1850");
  });

  it("replays the announced consolidation on the current compare, under a fresh identity", () => {
    const local = new LocalLoads();
    const w = stub();
    local.feed(w.post, { type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    local.resolve(parsed({ role: "main", fileName: "a.ged", profile: profileOf(MAIN) }));
    local.feed(w.post, { type: "parse", role: "compare", fileName: "b.ged", buffer: enc(COMPARE) });
    const compare = local.resolve(parsed({ role: "compare", fileName: "b.ged", ...normalizedBy(COMPARE, profileOf(MAIN)) }))!;
    expect(compare.individuals.size).toBe(2);
    const merged = local.resolve(
      parsed({ role: "compare", fileName: "b.ged", consolidated: [{ keepId: "@P1@", mergeIds: ["@P2@"] }] }),
    )!;
    expect(merged).not.toBe(compare);
    expect(merged.individuals.size).toBe(1);
    // The merged-away record's own facts travelled onto the survivor.
    expect(merged.individuals.get("@P1@")!.events.some((e) => e.tag === "DEAT")).toBe(true);
  });

  it("replays a consolidation that lands before the app re-rendered the compare", () => {
    // The worker posts parsed(compare) and parsed(consolidated) back to back;
    // both can be handled before React stores the first, so the app has no
    // compare (or the previous one) to hand over yet.
    const local = new LocalLoads();
    const w = stub();
    local.feed(w.post, { type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    local.resolve(parsed({ role: "main", fileName: "a.ged", profile: profileOf(MAIN) }));
    local.feed(w.post, { type: "parse", role: "compare", fileName: "b.ged", buffer: enc(COMPARE) });
    local.resolve(parsed({ role: "compare", fileName: "b.ged", ...normalizedBy(COMPARE, profileOf(MAIN)) }));
    const merged = local.resolve(parsed({ role: "compare", fileName: "b.ged", consolidated: [{ keepId: "@P1@", mergeIds: ["@P2@"] }] }));
    expect(merged?.individuals.size).toBe(1);
    expect(birthDate(merged!, "@P1@")).toBe("02.02.1850");
  });

  it("an announcement for a file this side did not build resolves to nothing", () => {
    const local = new LocalLoads();
    const w = stub();
    local.feed(w.post, { type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    // A different file than the one built — a superseded load's answer.
    expect(local.resolve(parsed({ role: "main", fileName: "other.ged" }))).toBeUndefined();
    expect(local.resolve(parsed({ role: "compare", fileName: "never.ged" }))).toBeUndefined();
  });

  it("clearCompare forgets the compare's bytes", () => {
    const local = new LocalLoads();
    const w = stub();
    local.feed(w.post, { type: "parse", role: "compare", fileName: "b.ged", buffer: enc(COMPARE) });
    local.feed(w.post, { type: "clearCompare" });
    expect(local.resolve(parsed({ role: "compare", fileName: "b.ged" }))).toBeUndefined();
  });
});

describe("LocalLoads behind the real worker", () => {
  const corpus = resolve(dirname(fileURLToPath(import.meta.url)), "../__fixtures__/corpus");
  const bytesOf = (file: string) => {
    const buf = readFileSync(resolve(corpus, file));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  };
  afterEach(() => vi.unstubAllGlobals());

  /** Load both files through the worker module in the given order, resolving
   *  every announcement here as the app does; returns the last compare. */
  async function loadThrough(order: readonly ("main" | "compare")[], files: Record<"main" | "compare", string>) {
    vi.resetModules();
    const posted: WorkerResponse[] = [];
    const scope = {
      onmessage: null as ((e: MessageEvent<WorkerRequest>) => void) | null,
      postMessage: (msg: WorkerResponse) => posted.push(msg),
    };
    vi.stubGlobal("self", scope);
    await import("../worker/gedcom.worker");
    const local = new LocalLoads();
    let compare: Dataset | undefined;
    for (const role of order) {
      const send = (msg: WorkerRequest) => scope.onmessage!({ data: msg } as MessageEvent<WorkerRequest>);
      local.feed(send, { type: "parse", role, fileName: files[role], buffer: bytesOf(files[role]) });
      for (const msg of posted.splice(0)) {
        if (msg.type !== "parsed") continue;
        // A normalized GEDCOM compare carries its edits: this side replays
        // them, it does not normalize again.
        if (msg.role === "compare" && msg.report && !msg.consolidated) expect(msg.normalized).toBeDefined();
        const ds = local.resolve(msg);
        expect(ds, `${msg.role} ${msg.fileName}`).toBeDefined();
        if (msg.role === "compare") compare = ds;
      }
    }
    return compare!;
  }

  it("holds the very compare the worker normalized, whichever file came first", async () => {
    const pairs: [string, string][] = [
      ["geneanet-5.5.1-utf8.ged", "brotherskeeper-5.5-w1250.ged"],
      ["synium-7.0-utf8.ged", "myheritage-5.5.1-utf8.ged"],
      ["familyhistorian-5.5.1-w1250.ged", "gramps-5.5.1-utf8.ged"],
    ];
    for (const [mainFile, compareFile] of pairs) {
      const profile = applyFormatOverrides(inferMainProfile(buildDataset(parseGedcom(bytesOf(mainFile)))), undefined);
      const raw = buildDataset(parseGedcom(bytesOf(compareFile)));
      const expected = normalizeDataset(raw, profile, collectLayoutValues(raw).dateValues).dataset;
      for (const order of [["main", "compare"], ["compare", "main"]] as const) {
        const got = await loadThrough(order, { main: mainFile, compare: compareFile });
        const label = `${compareFile} into ${mainFile}, ${order.join(" first, ")}`;
        expect(forestDiff(expected.records, got.records), label).toBeUndefined();
        expect(serializeGedcom(got.records, downloadOptions(got)), label).toBe(
          serializeGedcom(expected.records, downloadOptions(expected)),
        );
      }
    }
  });
});
