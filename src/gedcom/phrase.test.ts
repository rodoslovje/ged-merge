import { describe, expect, it } from "vitest";
import { buildDataset } from "./builder";
import { parseGedcom } from "./parser";
import { serializeDataset, serializeGedcom } from "./serialize";
import { dateText } from "./date";
import { setAdditionalName, setEventFieldAtIndex } from "./edit";
import { nameTypeLabel } from "../match/relatives";
import { migrateVersion } from "../normalize/migrate";
import { narrativeEn } from "../report/lang/en";
import { narrativeSl } from "../report/lang/sl";
import { validateStructure } from "../tools/structure";
import { individualFieldRows } from "../review/fields";

const tr = (key: string) => key;

function load(version: string, body: string) {
  const text = `0 HEAD\n1 GEDC\n2 VERS ${version}\n${body}0 TRLR\n`;
  return { text, ds: buildDataset(parseGedcom(new TextEncoder().encode(text).buffer)) };
}

const BODY =
  "0 @I1@ INDI\n1 NAME Ana /Novak/\n1 NAME Sestra Marija //\n2 TYPE OTHER\n3 PHRASE Redovniško ime\n" +
  "1 BAPM\n2 DATE 1850\n3 PHRASE Easter Sunday\n1 CONF\n2 DATE\n3 PHRASE in her twelfth year\n";

describe("PHRASE beside coded values", () => {
  it("reads a date's wording beside its value, and a wording-only date", () => {
    const { ds } = load("7.0", BODY);
    const [bapm, conf] = ds.individuals.get("@I1@")!.events;
    expect(bapm.date?.year).toBe(1850);
    expect(bapm.date?.phrase).toBe("Easter Sunday");
    expect(dateText(bapm.date!)).toBe("1850 (Easter Sunday)");
    expect(conf.date?.year).toBeUndefined();
    expect(dateText(conf.date!)).toBe("in her twelfth year");
  });

  it("shows the wording in reports and in the merge row's hover", () => {
    const { ds } = load("7.0", BODY);
    const bapm = ds.individuals.get("@I1@")!.events[0];
    expect(narrativeEn.datePhrase(bapm.date!)).toBe("in 1850 (Easter Sunday)");
    expect(narrativeSl.dateLabel(bapm.date!)).toBe("1850 (Easter Sunday)");
    const rows = individualFieldRows(tr, undefined, ds.individuals.get("@I1@"));
    expect(rows.find((r) => r.key === "BAPM.date")?.incomingTitle).toBe("1850 (Easter Sunday)");
  });

  it("reads a name type's wording in place of the coded type", () => {
    const { ds } = load("7.0", BODY);
    const other = ds.individuals.get("@I1@")!.names[1];
    expect(other.typePhrase).toBe("Redovniško ime");
    expect(nameTypeLabel(other.type!, tr, other.typePhrase)).toBe("Redovniško ime");
  });

  it("saves an untouched file byte for byte and keeps the wording through a date edit", () => {
    const { text, ds } = load("7.0", BODY);
    expect(serializeDataset(ds).replace(/\r\n/g, "\n")).toBe(text);
    const p = ds.individuals.get("@I1@")!;
    setEventFieldAtIndex(p, 0, { date: "1851" });
    expect(serializeGedcom([p.raw])).toContain("2 DATE 1851\n3 PHRASE Easter Sunday");
    // Choosing a different name type drops the wording of the old one.
    setAdditionalName(p, 0, { type: "aka" });
    expect(serializeGedcom([p.raw])).not.toContain("Redovniško ime");
  });

  it("does not take a wording-only date for a broken one", () => {
    const { ds } = load("7.0", BODY);
    const issues = validateStructure(ds).issues.filter((i) => i.category === "badDate");
    expect(issues).toEqual([]);
  });

  it("round-trips through the 5.5.1 ⇄ 7.0 migration", () => {
    const { ds } = load("7.0", BODY);
    migrateVersion(ds.records, "7.0", "5.5.1", () => {});
    const down = serializeGedcom(ds.records);
    expect(down).toContain("2 DATE INT 1850 (Easter Sunday)");
    expect(down).toContain("2 DATE (in her twelfth year)");
    migrateVersion(ds.records, "5.5.1", "7.0", () => {});
    const up = serializeGedcom(ds.records);
    expect(up).toContain("2 DATE 1850\n3 PHRASE Easter Sunday");
    expect(up).toContain("3 PHRASE in her twelfth year");
  });
});
