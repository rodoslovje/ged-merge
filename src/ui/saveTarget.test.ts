import { describe, it, expect, vi, beforeEach } from "vitest";

const downloadText = vi.hoisted(() => vi.fn());
vi.mock("./download", async (orig) => ({ ...(await orig<typeof import("./download")>()), downloadText }));

import { targetNames, writeSave, type SaveTarget } from "./saveTarget";

/** A file handle that keeps what was written to it — or refuses the write. */
function fakeFile(name: string, store: Map<string, string>, fail = false): FileSystemFileHandle {
  return {
    name,
    createWritable: async () => {
      if (fail) throw new Error("locked");
      let text = "";
      return {
        write: async (b: Blob) => { text = await b.text(); },
        close: async () => { store.set(name, text); },
      };
    },
  } as unknown as FileSystemFileHandle;
}

function fakeDir(store: Map<string, string>, fail = false): FileSystemDirectoryHandle {
  return {
    name: "tree",
    getFileHandle: async (name: string, opts?: { create?: boolean }) => {
      if (!opts?.create && !store.has(name)) throw new Error("NotFound");
      return fakeFile(name, store, fail);
    },
  } as unknown as FileSystemDirectoryHandle;
}

const FILES = ["Smith.2026-07-22.gedmerge.ged", "Smith.2026-07-22.gedmerge.report.txt"];
const NOW = new Date(2026, 6, 22, 14, 30);

beforeEach(() => downloadText.mockClear());

describe("targetNames", () => {
  it("keeps the dated names for a download and an empty folder", async () => {
    expect(await targetNames({ kind: "download" }, FILES, NOW)).toEqual(FILES);
    expect(await targetNames({ kind: "folder", dir: fakeDir(new Map()) }, FILES, NOW)).toEqual(FILES);
  });

  it("adds the time to both names when the folder holds an earlier save of the day", async () => {
    const dir = fakeDir(new Map([[FILES[0], "0 HEAD"]]));
    expect(await targetNames({ kind: "folder", dir }, FILES, NOW)).toEqual([
      "Smith.2026-07-22-1430.gedmerge.ged",
      "Smith.2026-07-22-1430.gedmerge.report.txt",
    ]);
  });

  it("names the GEDCOM after the file it overwrites", async () => {
    const handle = fakeFile("Smith.ged", new Map());
    expect(await targetNames({ kind: "file", handle }, FILES, NOW)).toEqual(["Smith.ged", FILES[1]]);
  });
});

describe("writeSave", () => {
  it("writes both files into the folder", async () => {
    const store = new Map<string, string>();
    const target: SaveTarget = { kind: "folder", dir: fakeDir(store) };
    expect(await writeSave(target, FILES[0], "0 HEAD", true)).toBe(true);
    expect(await writeSave(target, FILES[1], "report", false)).toBe(true);
    expect([...store]).toEqual([[FILES[0], "0 HEAD"], [FILES[1], "report"]]);
    expect(downloadText).not.toHaveBeenCalled();
  });

  it("overwrites the opened file with the GEDCOM and downloads its report", async () => {
    const store = new Map([["Smith.ged", "old"]]);
    const target: SaveTarget = { kind: "file", handle: fakeFile("Smith.ged", store) };
    expect(await writeSave(target, "Smith.ged", "0 HEAD", true)).toBe(true);
    expect(await writeSave(target, FILES[1], "report", false)).toBe(true);
    expect([...store]).toEqual([["Smith.ged", "0 HEAD"]]);
    expect(downloadText).toHaveBeenCalledExactlyOnceWith(FILES[1], "report");
  });

  it("downloads the file when the write fails, and says so", async () => {
    const store = new Map<string, string>();
    expect(await writeSave({ kind: "folder", dir: fakeDir(store, true) }, FILES[0], "0 HEAD", true)).toBe(false);
    expect(await writeSave({ kind: "file", handle: fakeFile("Smith.ged", store, true) }, "Smith.ged", "0 HEAD", true)).toBe(false);
    expect(store.size).toBe(0);
    expect(downloadText.mock.calls).toEqual([[FILES[0], "0 HEAD"], ["Smith.ged", "0 HEAD"]]);
  });
});
