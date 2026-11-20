import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { bulkNormalize } from "../tools/bulkNormalize";
import { individualFieldRows } from "../review/fields";
import { inferMainProfile } from "./profile";
import { normalizeDataset } from "./normalize";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const person = (id: string, events: string) => `0 ${id} INDI\n1 NAME Janez /Novak/\n${events}`;

/** A main that writes plain comma places and no addresses. */
const MAIN = wrap(
  person("@I1@", "1 BIRT\n2 DATE 1850\n2 PLAC Kranj, Gorenjska, Slovenija\n1 DEAT\n2 DATE 1910\n2 PLAC Ljubljana, Slovenija\n") +
    person("@I2@", "1 BIRT\n2 DATE 1880\n2 PLAC Kranj, Gorenjska, Slovenija\n") +
    person("@I3@", "1 BIRT\n2 DATE 1882\n2 PLAC Škofja Loka, Gorenjska, Slovenija\n"),
);

/** The incoming file's events as they read after normalizing to `main`. */
function normalized(mainText: string, incomingEvents: string) {
  const main = dataset(mainText);
  const { dataset: out, report } = normalizeDataset(dataset(wrap(person("@P1@", incomingEvents))), inferMainProfile(main));
  const text = serializeGedcom(out.records);
  return { main, out, report, text };
}

describe("an incoming place with an address, where the main already has the place", () => {
  it("is not a layout the incoming file is reshaped to as a whole", () => {
    expect(["plain-structured", "unknown", "address-only"]).toContain(inferMainProfile(dataset(MAIN)).place.layout);
  });

  it("becomes the main's place and an ADDR", () => {
    const { text, report } = normalized(MAIN, "1 BIRT\n2 DATE 1850\n2 PLAC Kranj, Gorenjska, Slovenija, Glavni trg 5\n");
    expect(text).toContain("1 BIRT\n2 DATE 1850\n2 PLAC Kranj, Gorenjska, Slovenija\n2 ADDR Glavni trg 5\n");
    expect(report.placesReshaped).toBe(1);
  });

  it("works for a main that writes the town alone", () => {
    const main = wrap(
      person("@I1@", "1 BIRT\n2 DATE 1850\n2 PLAC Kranj\n") + person("@I2@", "1 BIRT\n2 DATE 1880\n2 PLAC Kranj\n") +
        person("@I3@", "1 BIRT\n2 DATE 1882\n2 PLAC Ljubljana\n"),
    );
    const { text } = normalized(main, "1 BIRT\n2 DATE 1850\n2 PLAC Kranj, Glavni trg 5\n");
    expect(text).toContain("2 PLAC Kranj\n2 ADDR Glavni trg 5\n");
  });

  it("reads a packed place with its country in brackets, in the main's spelling of the country", () => {
    const main = wrap(person("@I1@", "1 BIRT\n2 DATE 1850\n2 PLAC Kranj, Slovenia\n"));
    const { text } = normalized(main, "1 BIRT\n2 DATE 1850\n2 PLAC Kranj (Slovenija), Kidričeva 38/a\n");
    expect(text).toContain("2 PLAC Kranj, Slovenia\n2 ADDR Kidričeva 38/a\n");
  });

  it("takes the main's own spelling of the place", () => {
    const { text } = normalized(MAIN, "1 BIRT\n2 DATE 1850\n2 PLAC kranj,gorenjska,slovenija, Glavni trg 5\n");
    expect(text).toContain("2 PLAC Kranj, Gorenjska, Slovenija\n2 ADDR Glavni trg 5\n");
  });

  it("then offers the address as a row with a line of its own to take", () => {
    const { main, out } = normalized(MAIN, "1 BIRT\n2 DATE 1850\n2 PLAC Kranj, Gorenjska, Slovenija, Glavni trg 5\n");
    const rows = individualFieldRows((k) => k, main.individuals.get("@I1@")!, out.individuals.get("@P1@")!, main, out);
    expect(rows.find((r) => r.key === "BIRT.place")).toMatchObject({ state: "agree" });
    expect(rows.find((r) => r.key === "BIRT.addr")).toMatchObject({ incoming: "Glavni trg 5", state: "incoming-only" });
  });

  it("leaves a place the main does not have as it is written", () => {
    const { text, report } = normalized(MAIN, "1 BIRT\n2 DATE 1850\n2 PLAC Tržič, Gorenjska, Slovenija, Glavni trg 5\n");
    expect(text).toContain("2 PLAC Tržič, Gorenjska, Slovenija, Glavni trg 5\n");
    expect(text).not.toContain("ADDR");
    expect(report.placesReshaped).toBe(0);
  });

  it("leaves a place alone when it has no address in it, or an ADDR beside it already", () => {
    const { text } = normalized(
      MAIN,
      "1 BIRT\n2 DATE 1850\n2 PLAC Kranj, Gorenjska, Slovenija\n1 DEAT\n2 DATE 1910\n2 PLAC Ljubljana, Slovenija, Trubarjeva 3\n2 ADDR Dom starejših\n",
    );
    expect(text).toContain("1 BIRT\n2 DATE 1850\n2 PLAC Kranj, Gorenjska, Slovenija\n1 DEAT");
    expect(text).toContain("2 PLAC Ljubljana, Slovenija, Trubarjeva 3\n2 ADDR Dom starejših\n");
  });

  it("is for an incoming file: Normalize leaves one's own places as written", () => {
    const own = wrap(
      person("@I1@", "1 BIRT\n2 DATE 1850\n2 PLAC Kranj, Gorenjska, Slovenija\n") +
        person("@I2@", "1 BIRT\n2 DATE 1880\n2 PLAC Kranj, Gorenjska, Slovenija\n") +
        person("@I3@", "1 BIRT\n2 DATE 1882\n2 PLAC Kranj, Gorenjska, Slovenija, Glavni trg 5\n"),
    );
    const out = serializeGedcom(bulkNormalize(dataset(own)).dataset.records);
    expect(out).toContain("2 PLAC Kranj, Gorenjska, Slovenija, Glavni trg 5\n");
    expect(out).not.toContain("ADDR");
  });
});
