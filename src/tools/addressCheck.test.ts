import { describe, expect, it } from "vitest";
import { addressDecisionKey, checkAddressesAgainstRegister } from "./addressCheck";
import type { AddressHit } from "../geo/addressRegister";
import type { AddressRow } from "./addresses";
import type { GeocodeDecision } from "../persist/geoDb";

function row(over: Partial<AddressRow> & Pick<AddressRow, "key" | "place" | "address">): AddressRow {
  return {
    rawKeys: [over.key],
    queries: [{ settlement: over.place.split(",")[0].trim(), number: 1 }],
    count: 1,
    covered: 0,
    people: ["@I1@"],
    ...over,
  };
}

function hit(over: Partial<AddressHit> & Pick<AddressHit, "address" | "settlement">): AddressHit {
  return {
    coord: { lat: 46, lon: 14.5 },
    street: "",
    label: over.address,
    number: 1,
    ...over,
  };
}

const NO_DECISIONS = new Map<string, GeocodeDecision>();

describe("checkAddressesAgainstRegister", () => {
  it("reports a street the register spells differently", () => {
    const r = row({ key: "kranj|kidriceva 38", place: "Kranj, Slovenija", address: "Kidričeva 38" });
    const report = checkAddressesAgainstRegister(
      [r],
      new Map([[r.key, [hit({ address: "Kidričeva cesta 38", street: "Kidričeva cesta", settlement: "Kranj", label: "Kidričeva cesta 38, 4000 Kranj" })]]]),
      NO_DECISIONS,
    );
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      verdict: "addrSpelling",
      written: "Kidričeva 38",
      officialAddress: "Kidričeva cesta 38",
    });
    expect(report).toMatchObject({ checked: 1, ok: 0, skipped: 0 });
  });

  it("carries the file's own bracketed note into the spelling it would write", () => {
    const r = row({
      key: "kranj|kidriceva 38 (porodnisnica)",
      place: "Kranj, Slovenija",
      address: "Kidričeva 38 (porodnišnica)",
    });
    const report = checkAddressesAgainstRegister(
      [r],
      new Map([
        [
          r.key,
          [hit({ address: "Kidričeva cesta 38", street: "Kidričeva cesta", settlement: "Kranj", label: "Kidričeva cesta 38, 4000 Kranj" })],
        ],
      ]),
      NO_DECISIONS,
    );
    // The note is the researcher's, not the register's: taking the official
    // spelling must not swallow what only the file knows about the house.
    expect(report.findings[0]).toMatchObject({
      verdict: "addrSpelling",
      officialAddress: "Kidričeva cesta 38 (porodnišnica)",
    });
  });

  it("reports a house the register files under another settlement", () => {
    const r = row({ key: "gradac|kloster 12", place: "Gradac, Metlika, Slovenija", address: "Klošter 12" });
    const report = checkAddressesAgainstRegister(
      [r],
      new Map([[r.key, [hit({ address: "Klošter 12", settlement: "Klošter", label: "Klošter 12, 8332 Gradac" })]]]),
      NO_DECISIONS,
    );
    expect(report.findings[0]).toMatchObject({
      verdict: "addrElsewhere",
      settlement: "Klošter",
      // The file's own layout with the settlement swapped — not a fresh string.
      officialPlace: "Klošter, Metlika, Slovenija",
    });
  });

  it("says nothing when the register agrees", () => {
    const r = row({ key: "kranj|kidriceva cesta 38", place: "Kranj, Slovenija", address: "Kidričeva cesta 38" });
    const report = checkAddressesAgainstRegister(
      [r],
      new Map([[r.key, [hit({ address: "Kidričeva cesta 38", street: "Kidričeva cesta", settlement: "Kranj" })]]]),
      NO_DECISIONS,
    );
    expect(report.findings).toEqual([]);
    expect(report).toMatchObject({ checked: 1, ok: 1 });
  });

  it("does not call a bare house number a misspelt street", () => {
    // The file keeps the number alone on its ADDR line; the register names the
    // street. Different shapes, not a disagreement about spelling.
    const r = row({ key: "kranj|38", place: "Kranj, Slovenija", address: "38" });
    const report = checkAddressesAgainstRegister(
      [r],
      new Map([[r.key, [hit({ address: "Kidričeva cesta 38", street: "Kidričeva cesta", settlement: "Kranj" })]]]),
      NO_DECISIONS,
    );
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(1);
  });

  it("reports a number the register does not have", () => {
    const r = row({ key: "strazisce|114", place: "Stražišče, Kranj, Slovenija", address: "Stražišče 114" });
    const report = checkAddressesAgainstRegister([r], new Map([[r.key, []]]), NO_DECISIONS);
    expect(report.findings[0].verdict).toBe("addrMissing");
  });

  it("leaves an ambiguous answer to the Addresses tab", () => {
    // Two houses of that number in the settlement: the register could not say
    // which, so there is nothing here to disagree with.
    const r = row({ key: "vrbovsko|75", place: "Vrbovsko, Hrvaška", address: "Ul. Senjsko 75" });
    const report = checkAddressesAgainstRegister(
      [r],
      new Map([
        [
          r.key,
          [
            hit({ address: "Senjsko 75", street: "Senjsko", settlement: "Vrbovsko" }),
            hit({ address: "Ivana Gorana Kovačića 75", street: "Ivana Gorana Kovačića", settlement: "Vrbovsko" }),
          ],
        ],
      ]),
      NO_DECISIONS,
    );
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(1);
  });

  it("skips a row nothing was asked about", () => {
    // No register stored for its country — not checked, and never reported as
    // agreeing either.
    const r = row({ key: "wien|ringstrasse 1", place: "Wien, Österreich", address: "Ringstrasse 1" });
    const report = checkAddressesAgainstRegister([r], new Map(), NO_DECISIONS);
    expect(report).toMatchObject({ findings: [], checked: 0, ok: 0, skipped: 1 });
  });

  it("marks a dismissed finding and sinks it", () => {
    const kept = row({ key: "a|1", place: "Kranj, Slovenija", address: "Kidričeva 1" });
    const gone = row({ key: "b|2", place: "Kranj, Slovenija", address: "Kidričeva 2" });
    const answer = (n: number) => [hit({ address: `Kidričeva cesta ${n}`, street: "Kidričeva cesta", settlement: "Kranj" })];
    const report = checkAddressesAgainstRegister(
      [kept, gone],
      new Map([
        [kept.key, answer(1)],
        [gone.key, answer(2)],
      ]),
      new Map([[addressDecisionKey(gone.key), { key: addressDecisionKey(gone.key), status: "historic", ts: 0 }]]),
    );
    expect(report.findings.map((f) => [f.key, f.dismissed])).toEqual([
      ["a|1", false],
      ["b|2", true],
    ]);
  });

  it("puts the worst verdict first", () => {
    const elsewhere = row({ key: "e", place: "Gradac, Slovenija", address: "Klošter 12" });
    const spelling = row({ key: "s", place: "Kranj, Slovenija", address: "Kidričeva 38" });
    const missing = row({ key: "m", place: "Kranj, Slovenija", address: "Kidričeva 99" });
    const report = checkAddressesAgainstRegister(
      [missing, spelling, elsewhere],
      new Map([
        [missing.key, []],
        [spelling.key, [hit({ address: "Kidričeva cesta 38", street: "Kidričeva cesta", settlement: "Kranj" })]],
        [elsewhere.key, [hit({ address: "Klošter 12", settlement: "Klošter" })]],
      ]),
      NO_DECISIONS,
    );
    expect(report.findings.map((f) => f.verdict)).toEqual(["addrElsewhere", "addrSpelling", "addrMissing"]);
  });
});
