import { describe, expect, it } from "vitest";
import { charsetNotices } from "./charsetNotice";
import type { ParseWarning } from "../gedcom/types";

/** Keys back, so a test reads as "which notices", not "which wording". */
const t = (key: string, opts?: Record<string, unknown>) =>
  opts?.charset ? `${key}:${opts.charset}` : key;

const undecodable: ParseWarning = {
  kind: "encoding",
  code: "undecodable",
  message: "3 byte(s) could not be decoded and were replaced with �; the source file may be corrupted.",
};

describe("charsetNotices", () => {
  it("says nothing for a clean UTF-8 file", () => {
    expect(charsetNotices({ charset: "UTF-8", warnings: [] }, t)).toEqual([]);
  });

  it("announces the rewrite for a file that arrived in another encoding", () => {
    expect(charsetNotices({ charset: "ANSEL", warnings: [] }, t)).toEqual(["gedcom.charsetNotice:ANSEL"]);
  });

  it("warns about unreadable characters even when the file was UTF-8", () => {
    // Saving converts nothing here, but the � are still in the data.
    expect(charsetNotices({ charset: "UTF-8", warnings: [undecodable] }, t)).toEqual(["gedcom.charsetLost"]);
  });

  it("says both when a legacy file also lost characters, conversion first", () => {
    expect(charsetNotices({ charset: "WINDOWS-1250", warnings: [undecodable] }, t)).toEqual([
      "gedcom.charsetNotice:WINDOWS-1250",
      "gedcom.charsetLost",
    ]);
  });

  it("ignores encoding warnings that aren't about lost characters", () => {
    const repaired: ParseWarning = { kind: "encoding", message: "Repaired 2 double-encoded (mojibake) text run(s)." };
    expect(charsetNotices({ charset: "UTF-8", warnings: [repaired] }, t)).toEqual([]);
  });
});
