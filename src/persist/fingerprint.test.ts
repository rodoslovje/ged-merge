import { describe, expect, it } from "vitest";
import { hashFile, hasPermApi } from "./fingerprint";

describe("hashFile", () => {
  it("is the hex SHA-256 of the file's bytes", async () => {
    // SHA-256("abc"), the FIPS 180-2 test vector.
    expect(await hashFile(new File(["abc"], "a.ged"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("tells an edited file from the one loaded", async () => {
    const a = await hashFile(new File(["0 HEAD\n0 TRLR\n"], "a.ged"));
    const b = await hashFile(new File(["0 HEAD\n1 NOTE x\n0 TRLR\n"], "a.ged"));
    expect(a).not.toBe(b);
  });
});

describe("hasPermApi", () => {
  it("is true only where the handle can be asked for permission", () => {
    expect(hasPermApi({ kind: "file", name: "a" } as unknown as FileSystemHandle)).toBe(false);
    const chrome = { kind: "file", name: "a", queryPermission: async () => "granted" };
    expect(hasPermApi(chrome as unknown as FileSystemHandle)).toBe(true);
  });
});
