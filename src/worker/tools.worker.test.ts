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

describe("tools worker scans", () => {
  const scanTypes = ["validate", "sourceDuplicates", "sourceReshape", "normalizePreview"] as const;
  const idOf = (m: ToolsResponse) => ("requestId" in m ? m.requestId : 0);

  it("a scan before any main answers an error, not a result", async () => {
    const send = await freshWorker();
    send({ type: "validate", requestId: 1 });
    expect(posted).toEqual([{ type: "error", requestId: 1, message: "no dataset loaded" }]);
  });

  it("a patch with no main to apply it to asks for the whole main", async () => {
    const send = await freshWorker();
    send({ type: "patchMain", patch: recordsPatch(dsOf(FILE), new Set(["@I1@"]))! });
    expect(posted).toEqual([{ type: "resync" }]);
  });

  it("answers each scan kind with its own result, tagged with its request id", async () => {
    const send = await freshWorker();
    send({ type: "setMain", snapshot: mainSnapshot(dsOf(FILE)) });
    scanTypes.forEach((type, i) => send({ type, requestId: 10 + i }));
    expect(posted.map((m) => [m.type, idOf(m)])).toEqual([["result", 10], ["result", 11], ["result", 12], ["result", 13]]);
    const [validate, sources, reshape, preview] = posted.map((m) => (m.type === "result" ? m.data : undefined)) as object[];
    expect(Object.keys(validate)).toEqual(["report", "structure"]);
    expect(sources).toHaveProperty("report");
    expect(reshape).toHaveProperty("report");
    expect(preview).toHaveProperty("report");
  });

  it("reports the duplicate scan's progress on a large file, under the scan's id", async () => {
    const send = await freshWorker();
    // Progress comes every 256 people; just past one step keeps the scan short.
    const many = Array.from({ length: 300 }, (_, i) => person(`@I${i + 1}@`, `Oseba${i} /Priimek${i}/`)).join("");
    send({ type: "setMain", snapshot: mainSnapshot(dsOf(`0 HEAD\n${many}0 TRLR\n`)) });
    send({ type: "findDuplicates", requestId: 8 });
    expect(posted.filter((m) => m.type === "progress")).toEqual([{ type: "progress", requestId: 8, done: 256, total: 300 }]);
    expect(posted.at(-1)).toMatchObject({ type: "result", requestId: 8 });
  }, 30_000);

  it("a scan that throws answers an error for that request and keeps the worker usable", async () => {
    vi.doMock("../tools/sourceDuplicates", () => ({
      findSourceDuplicates: () => {
        throw new Error("boom");
      },
    }));
    try {
      const send = await freshWorker();
      send({ type: "setMain", snapshot: mainSnapshot(dsOf(FILE)) });
      send({ type: "sourceDuplicates", requestId: 3 });
      send({ type: "validate", requestId: 4 });
      expect(posted.map((m) => [m.type, idOf(m)])).toEqual([["error", 3], ["result", 4]]);
      expect(posted[0]).toMatchObject({ message: "boom" });
    } finally {
      vi.doUnmock("../tools/sourceDuplicates");
    }
  });

  it("a scan that throws something other than an Error still answers its message", async () => {
    vi.doMock("../tools/sourceDuplicates", () => ({
      findSourceDuplicates: () => {
        throw "no records";
      },
    }));
    try {
      const send = await freshWorker();
      send({ type: "setMain", snapshot: mainSnapshot(dsOf(FILE)) });
      send({ type: "sourceDuplicates", requestId: 7 });
      expect(posted).toEqual([{ type: "error", requestId: 7, message: "no records" }]);
    } finally {
      vi.doUnmock("../tools/sourceDuplicates");
    }
  });

  it("a scan posted after a stale patch waits for the whole main, then runs on it", async () => {
    const send = await freshWorker();
    const live = dsOf(FILE);
    send({ type: "setMain", snapshot: mainSnapshot(live) });
    const other = dsOf(`0 HEAD\n${person("@I5@", "Ana /Kos/")}${person("@I9@", "Janez /Novak/")}0 TRLR\n`);
    send({ type: "patchMain", patch: recordsPatch(other, new Set(["@I9@"]))! });
    send({ type: "validate", requestId: 1 });
    send({ type: "patchMain", patch: recordsPatch(live, new Set(["@I1@"]))! }); // waits, then is dropped
    send({ type: "findDuplicates", requestId: 2 });
    expect(posted.map((m) => m.type)).toEqual(["resync"]);
    send({ type: "setMain", snapshot: mainSnapshot(live) });
    expect(posted.map((m) => [m.type, idOf(m)])).toEqual([["resync", 0], ["result", 1], ["result", 2]]);
  });
});
