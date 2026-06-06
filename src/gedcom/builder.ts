import { parseDate } from "./date";
import { parseName } from "./name";
import { parsePlace } from "./place";
import type {
  Dataset,
  Family,
  GedEvent,
  GedNode,
  Individual,
  ParseResult,
  Sex,
} from "./types";

/** Event-bearing tags we lift into the typed `events` array. */
const INDI_EVENT_TAGS = new Set([
  "BIRT", "DEAT", "BAPM", "CHR", "BURI", "CREM", "MARR", "RESI",
]);
const FAM_EVENT_TAGS = new Set(["MARR", "DIV", "ENGA", "MARB", "MARL"]);

/** Build the typed domain `Dataset` from a parsed line tree. */
export function buildDataset(parsed: ParseResult): Dataset {
  const individuals = new Map<string, Individual>();
  const families = new Map<string, Family>();

  for (const record of parsed.records) {
    if (record.tag === "INDI" && record.xref) {
      individuals.set(record.xref, buildIndividual(record));
    } else if (record.tag === "FAM" && record.xref) {
      families.set(record.xref, buildFamily(record));
    }
  }

  return {
    version: parsed.version,
    charset: parsed.charset,
    individuals,
    families,
    records: parsed.records,
    warnings: parsed.warnings,
  };
}

function buildIndividual(record: GedNode): Individual {
  const names: Individual["names"] = [];
  const events: GedEvent[] = [];
  const childOf: string[] = [];
  const spouseOf: string[] = [];
  let sex: Sex = "U";

  for (const child of record.children) {
    switch (child.tag) {
      case "NAME":
        names.push(parseName(child.value, subTagMap(child)));
        break;
      case "SEX":
        sex = normalizeSex(child.value);
        break;
      case "FAMC":
        if (child.value) childOf.push(child.value.trim());
        break;
      case "FAMS":
        if (child.value) spouseOf.push(child.value.trim());
        break;
      default:
        if (INDI_EVENT_TAGS.has(child.tag)) events.push(buildEvent(child));
    }
  }

  return { id: record.xref!, names, sex, events, childOf, spouseOf, raw: record };
}

function buildFamily(record: GedNode): Family {
  const children: string[] = [];
  const events: GedEvent[] = [];
  let husband: string | undefined;
  let wife: string | undefined;

  for (const child of record.children) {
    switch (child.tag) {
      case "HUSB":
        husband = child.value?.trim();
        break;
      case "WIFE":
        wife = child.value?.trim();
        break;
      case "CHIL":
        if (child.value) children.push(child.value.trim());
        break;
      default:
        if (FAM_EVENT_TAGS.has(child.tag)) events.push(buildEvent(child));
    }
  }

  const fam: Family = { id: record.xref!, children, events, raw: record };
  if (husband) fam.husband = husband;
  if (wife) fam.wife = wife;
  return fam;
}

function buildEvent(node: GedNode): GedEvent {
  const event: GedEvent = { tag: node.tag };
  const dateNode = node.children.find((c) => c.tag === "DATE");
  const placeNode = node.children.find((c) => c.tag === "PLAC");
  const addrNode = node.children.find((c) => c.tag === "ADDR");
  if (dateNode?.value) event.date = parseDate(dateNode.value);
  if (placeNode?.value) event.place = parsePlace(placeNode.value);
  if (addrNode?.value) event.address = parsePlace(addrNode.value);
  return event;
}

function subTagMap(node: GedNode): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of node.children) {
    if (c.value !== undefined) map.set(c.tag, c.value.trim());
  }
  return map;
}

function normalizeSex(value: string | undefined): Sex {
  const v = value?.trim().toUpperCase();
  return v === "M" || v === "F" ? v : "U";
}
