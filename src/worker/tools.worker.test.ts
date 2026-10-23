import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import type { Dataset } from "../gedcom/types";
import { mainSnapshot, recordsPatch } from "../state/mainSync";
import type { ToolsRequest, ToolsResponse } from "./toolsMessages";

/**
 * The tools worker's copy of the main: sent whole once, then kept in step by
 * the edited records — and asked for whole again when a patch does not fit.
 */

const enc = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
const person = (xref: string, name: string) => `0 ${xref} INDI\n1 NAME ${name}\n1 SEX M\n1 BIRT\n2 DATE 2 FEB 1850\n2 PLAC Kranj\n`;
const FILE = `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${person("@I1@", "Janez /Novak/")}${person("@I2@", "Ana /Kos/")}0 TRLR\n`;
const dsOf = (text: string): Dataset => buildDataset(parseGedcom(enc(text)));

let posted: ToolsResponse[];

async function freshWorker(): Promise<(req: ToolsRequest) => void> {
  posted = [];
  const scope = {
    onmessage: null as ((e: MessageEvent<ToolsRequest>) => void) | null,
    postMessage: (msg: ToolsResponse) => posted.push(msg),
  };
  vi.stubGlobal("self", scope);
  await import("./tools.worker");
  return (req) => scope.onmessage!({ data: req } as MessageEvent<ToolsRequest>);
}

/** The duplicate pairs the last finished scan reported, as "a|b" id keys. */
const lastPairs = () => {
  const res = [...posted].reverse().find((m) => m.type === "result");
  if (res?.type !== "result") return undefined;
  return (res.data as { pairs: { aId: string; bId: string }[] }).pairs.map((p) => [p.aId, p.bId].sort().join("|"));
};

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("tools worker main copy", () => {
  it("scans the whole main it was sent, then the edits patched into it", async () => {
    const send = await freshWorker();
    const live = dsOf(FILE);
    send({ type: "setMain", snapshot: mainSnapshot(live) });
    send({ type: "findDuplicates", requestId: 1 });
    expect(lastPairs()).toEqual([]);
    // @I2@ renamed into @I1@'s twin on the main thread.
    live.records.find((r) => r.xref === "@I2@")!.children[0].value = "Janez /Novak/";
    send({ type: "patchMain", patch: recordsPatch(live, new Set(["@I2@"]))! });
    send({ type: "findDuplicates", requestId: 2 });
    expect(lastPairs()).toEqual(["@I1@|@I2@"]);
  });

  it("a patch its copy does not take asks for the whole main, and the scans wait for it", async () => {
    const send = await freshWorker();
    send({ type: "setMain", snapshot: mainSnapshot(dsOf(FILE)) });
    posted = [];
    // Made against a copy holding an @I5@ this one never had.
    const other = dsOf(`0 HEAD\n${person("@I5@", "Ana /Kos/")}${person("@I9@", "Janez /Novak/")}0 TRLR\n`);
    send({ type: "patchMain", patch: recordsPatch(other, new Set(["@I9@"]))! });
    send({ type: "findDuplicates", requestId: 3 });
    send({ type: "patchMain", patch: recordsPatch(dsOf(FILE), new Set(["@I1@"]))! }); // superseded below
    expect(posted.map((m) => m.type)).toEqual(["resync"]);
    const twins = dsOf(`0 HEAD\n${person("@I1@", "Janez /Novak/")}${person("@I2@", "Janez /Novak/")}0 TRLR\n`);
    send({ type: "setMain", snapshot: mainSnapshot(twins) });
    expect(posted.map((m) => m.type)).toEqual(["resync", "result"]);
    expect(lastPairs()).toEqual(["@I1@|@I2@"]);
  });
});
