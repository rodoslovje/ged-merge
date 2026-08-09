import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddressCollector, type AddressBucket, type AddressIndex, type AddressRow } from "./addressRegister";

// The stored register stands in for IndexedDB: one index record and one bucket
// per settlement, exactly what geoDb hands back.
const store: { index?: AddressIndex; buckets: Map<string, AddressBucket> } = { buckets: new Map() };

vi.mock("../persist/geoDb", () => ({
  getAddressIndex: async () => store.index,
  getAddressBucket: async (key: string) => store.buckets.get(key),
}));

const { invalidateAddressRegisters, searchLocalAddress } = await import("./addressLookup");

/** One register row, written the way both registers resolve theirs. */
function row(opts: Partial<AddressRow> & { settlement: string; number: number }): AddressRow {
  return {
    settlementId: opts.settlementId ?? opts.settlement,
    settlement: opts.settlement,
    municipality: opts.municipality ?? "Metlika",
    street: opts.street ?? "",
    post: opts.post ?? "8330 Metlika",
    number: opts.number,
    ext: opts.ext ?? "",
    ext2: opts.ext2 ?? 0,
    lat: opts.lat ?? 45.65,
    lon: opts.lon ?? 15.32,
  };
}

function load(rows: AddressRow[]): void {
  const collector = new AddressCollector("SI");
  for (const r of rows) collector.add(r);
  store.index = collector.index(0);
  store.buckets = new Map(collector.buckets().map((b) => [b.key, b]));
  invalidateAddressRegisters();
}

describe("searchLocalAddress and the settlements it widens to", () => {
  beforeEach(() => {
    store.index = undefined;
    store.buckets.clear();
    invalidateAddressRegisters();
  });

  // Krasinec is a village in občina Metlika, numbering its houses directly; the
  // town of Metlika a few km away numbers its by street. Both are in the file's
  // own place value, "Krasinec, Metlika, Slovenija".
  const belaKrajina = [
    row({ settlement: "Krasinec", number: 51, post: "8332 Gradac", lat: 45.58672, lon: 15.28106 }),
    row({ settlement: "Metlika", street: "Cankarjeva cesta", number: 52, lat: 45.6475, lon: 15.32743 }),
    row({ settlement: "Metlika", street: "Cankarjeva cesta", number: 57, lat: 45.65033, lon: 15.32663 }),
    row({ settlement: "Metlika", street: "Cesta bratstva in enotnosti", number: 57, lat: 45.65022, lon: 15.31655 }),
  ];
  const krasinec = (number: number) => ({
    settlement: "Krasinec",
    number,
    altSettlements: ["Metlika"],
    parents: ["Metlika"],
  });

  it("answers a village house from its own village", async () => {
    load(belaKrajina);
    const hits = await searchLocalAddress("SI", krasinec(51));
    expect(hits.map((h) => h.label)).toEqual(["Krasinec 51, 8332 Gradac"]);
  });

  it("does not answer a missing village house with a street of the občina seat", async () => {
    // The register holds every house of Krasinec, so "there is no 52" is its
    // answer. Widening to Metlika — named only as the parent — used to offer
    // Cankarjeva cesta 52, a town street 8 km away, and the municipality guard
    // could not catch it: those houses are in občina Metlika, which is exactly
    // what the place names.
    load(belaKrajina);
    expect(await searchLocalAddress("SI", krasinec(52))).toEqual([]);
    expect(await searchLocalAddress("SI", krasinec(57))).toEqual([]);
  });

  it("still widens when the register has never heard of the settlement", async () => {
    // Nothing is lost for a hamlet (or a spelling) the register does not keep:
    // the parent level is all there is left to try. Only the narrow reading of
    // it, though — a house the town numbers directly, never one of its streets.
    load([
      ...belaKrajina,
      row({ settlement: "Metlika", number: 9, street: "", lat: 45.6501, lon: 15.3101 }),
    ]);
    const hamlet = (number: number) => ({
      settlement: "Boldraž",
      number,
      altSettlements: ["Metlika"],
      parents: ["Metlika"],
    });
    expect((await searchLocalAddress("SI", hamlet(9))).map((h) => h.label)).toEqual(["Metlika 9, 8330 Metlika"]);
    // 52 is a Metlika street number, and a settlement nobody named gets no
    // street guessed on top of it.
    expect(await searchLocalAddress("SI", hamlet(52))).toEqual([]);
  });

  it("keeps widening for a street the register files under the town", async () => {
    // The case the alternate rung exists for: the record says Stražišče, the
    // register files Hafnarjeva pot under naselje Kranj. A named street keeps
    // the rung whether or not the register knows the village.
    load([
      row({ settlement: "Stražišče", street: "Škofjeloška cesta", number: 4, municipality: "Kranj", post: "4000 Kranj" }),
      row({
        settlement: "Kranj",
        street: "Hafnarjeva pot",
        number: 21,
        municipality: "Kranj",
        post: "4000 Kranj",
        lat: 46.2477,
        lon: 14.3419,
      }),
    ]);
    const hits = await searchLocalAddress("SI", {
      settlement: "Stražišče",
      street: "Hafnarjeva pot",
      number: 21,
      altSettlements: ["Kranj"],
      parents: ["Kranj"],
    });
    expect(hits.map((h) => h.label)).toEqual(["Hafnarjeva pot 21, Kranj, 4000 Kranj"]);
  });

  it("offers every street of the settlement the file itself names", async () => {
    // "Bled 4" written village-style in a settlement that does have streets:
    // the file does not say which street, so all of them are offered and the
    // researcher picks. This widening is the file's own settlement's alone.
    load([
      row({ settlement: "Bled", street: "Mlinska cesta", number: 4, municipality: "Bled", post: "4260 Bled" }),
      row({ settlement: "Bled", street: "Prešernova cesta", number: 4, municipality: "Bled", post: "4260 Bled", lon: 14.11 }),
    ]);
    const hits = await searchLocalAddress("SI", { settlement: "Bled", number: 4, parents: ["Bled"] });
    expect(hits.map((h) => h.address)).toEqual(["Mlinska cesta 4", "Prešernova cesta 4"]);
  });
});
