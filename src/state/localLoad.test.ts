import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import type { Dataset } from "../gedcom/types";
import { applyFormatOverrides } from "../normalize/formatOverrides";
import { inferMainProfile } from "../normalize/profile";
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
    const ds = local.resolve(parsed({ role: "main", fileName: "a.ged", profile: profileOf(MAIN) }), undefined);
    expect(ds?.individuals.has("@I1@")).toBe(true);
  });

  it("a silent re-feed and a table load only pass through", () => {
    const local = new LocalLoads();
    const w = stub();
    local.feed(w.post, { type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN), silent: true });
    local.feed(w.post, { type: "parseCsv", fileName: "t.csv", buffer: enc("x") });
    expect(w.sent.map((s) => s.msg.type)).toEqual(["parse", "parseCsv"]);
    // Nothing was built: a main announced now has no local copy.
    expect(local.resolve(parsed({ role: "main", fileName: "a.ged" }), undefined)).toBeUndefined();
  });

  it("a table compare's dataset comes from the message itself", () => {
    const local = new LocalLoads();
    const table = dsOf(COMPARE);
    expect(local.resolve(parsed({ role: "compare", fileName: "t.csv", dataset: table }), undefined)).toBe(table);
  });

  it("normalizes a compare against the profile the main announced", () => {
    const local = new LocalLoads();
    const w = stub();
    local.feed(w.post, { type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    local.resolve(parsed({ role: "main", fileName: "a.ged", profile: profileOf(MAIN) }), undefined);
    local.feed(w.post, { type: "parse", role: "compare", fileName: "b.ged", buffer: enc(COMPARE) });
    const compare = local.resolve(parsed({ role: "compare", fileName: "b.ged" }), undefined);
    expect(birthDate(compare!, "@P1@")).toBe("02.02.1850"); // reshaped to the main's DD.MM.YYYY
  });

  it("a compare loaded before any main is announced raw, then normalized once the main lands", () => {
    const local = new LocalLoads();
    const w = stub();
    local.feed(w.post, { type: "parse", role: "compare", fileName: "b.ged", buffer: enc(COMPARE) });
    const raw = local.resolve(parsed({ role: "compare", fileName: "b.ged" }), undefined);
    expect(birthDate(raw!, "@P1@")).toBe("2 FEB 1850");
    local.feed(w.post, { type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    local.resolve(parsed({ role: "main", fileName: "a.ged", profile: profileOf(MAIN) }), undefined);
    // The worker re-announces the compare; this side normalizes its kept raw copy.
    const normalized = local.resolve(parsed({ role: "compare", fileName: "b.ged" }), raw);
    expect(birthDate(normalized!, "@P1@")).toBe("02.02.1850");
  });

  it("a later main re-normalizes the compare from its bytes, after the raw copy was dropped", () => {
    const local = new LocalLoads();
    const w = stub();
    local.feed(w.post, { type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    local.resolve(parsed({ role: "main", fileName: "a.ged", profile: profileOf(MAIN) }), undefined);
    local.feed(w.post, { type: "parse", role: "compare", fileName: "b.ged", buffer: enc(COMPARE) });
    const first = local.resolve(parsed({ role: "compare", fileName: "b.ged" }), undefined);
    // A new main with the GEDCOM date style: the compare must read that way now.
    const main2 = wrap("0 @I2@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 2 FEB 1850\n2 PLAC Kranj\n");
    local.feed(w.post, { type: "parse", role: "main", fileName: "a2.ged", buffer: enc(main2) });
    local.resolve(parsed({ role: "main", fileName: "a2.ged", profile: profileOf(main2) }), undefined);
    const second = local.resolve(parsed({ role: "compare", fileName: "b.ged" }), first);
    expect(second).not.toBe(first);
    expect(birthDate(second!, "@P1@")).toBe("2 FEB 1850");
  });

  it("replays the announced consolidation on the current compare, under a fresh identity", () => {
    const local = new LocalLoads();
    const w = stub();
    local.feed(w.post, { type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    local.resolve(parsed({ role: "main", fileName: "a.ged", profile: profileOf(MAIN) }), undefined);
    local.feed(w.post, { type: "parse", role: "compare", fileName: "b.ged", buffer: enc(COMPARE) });
    const compare = local.resolve(parsed({ role: "compare", fileName: "b.ged" }), undefined)!;
    expect(compare.individuals.size).toBe(2);
    const merged = local.resolve(
      parsed({ role: "compare", fileName: "b.ged", consolidated: [{ keepId: "@P1@", mergeIds: ["@P2@"] }] }),
      compare,
    )!;
    expect(merged).not.toBe(compare);
    expect(merged.individuals.size).toBe(1);
    // The merged-away record's own facts travelled onto the survivor.
    expect(merged.individuals.get("@P1@")!.events.some((e) => e.tag === "DEAT")).toBe(true);
  });

  it("an announcement for a file this side did not build resolves to nothing", () => {
    const local = new LocalLoads();
    const w = stub();
    local.feed(w.post, { type: "parse", role: "main", fileName: "a.ged", buffer: enc(MAIN) });
    // A different file than the one built — a superseded load's answer.
    expect(local.resolve(parsed({ role: "main", fileName: "other.ged" }), undefined)).toBeUndefined();
    expect(local.resolve(parsed({ role: "compare", fileName: "never.ged" }), undefined)).toBeUndefined();
  });

  it("clearCompare forgets the compare's bytes", () => {
    const local = new LocalLoads();
    const w = stub();
    local.feed(w.post, { type: "parse", role: "compare", fileName: "b.ged", buffer: enc(COMPARE) });
    local.feed(w.post, { type: "clearCompare" });
    expect(local.resolve(parsed({ role: "compare", fileName: "b.ged" }), undefined)).toBeUndefined();
  });
});
