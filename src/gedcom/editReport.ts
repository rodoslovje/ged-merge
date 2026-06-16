import type { Dataset, GedNode } from "./types";
import type { ChangeReport, FieldChange } from "../merge/merge";
import { displayName } from "../match/relatives";

type Translate = (key: string, opts?: Record<string, unknown>) => string;

const INDIVIDUAL_EVENT_TAGS = new Set([
  "BIRT", "BAPM", "CHR", "DEAT", "BURI", "CREM", "CONF", "ADOP", "FCOM",
  "OCCU", "EDUC", "RETI", "RESI", "EMIG", "IMMI", "NATU", "CENS", "WILL", "PROB",
]);

const FAMILY_EVENT_TAGS = new Set(["MARR", "ENGA", "SEPA", "DIV"]);

function nodeChild(node: GedNode, tag: string): string {
  return node.children.find((c) => c.tag === tag)?.value?.trim() ?? "";
}

function nodeSub(node: GedNode, tag: string, subTag: string): string {
  const ev = node.children.find((c) => c.tag === tag);
  return ev?.children.find((c) => c.tag === subTag)?.value?.trim() ?? "";
}

function diffIndividualNodes(id: string, before: GedNode, after: GedNode, t: Translate): FieldChange[] {
  const diffs: FieldChange[] = [];
  const check = (field: string, from: string, to: string) => {
    if (from !== to) diffs.push({ recordId: id, field, from, to, action: "incoming" });
  };

  check(t("field.given"),   nodeSub(before, "NAME", "GIVN"), nodeSub(after, "NAME", "GIVN"));
  check(t("field.surname"),  nodeSub(before, "NAME", "SURN"), nodeSub(after, "NAME", "SURN"));
  check(t("field.nickname"), nodeSub(before, "NAME", "NICK"), nodeSub(after, "NAME", "NICK"));
  check(t("field.sex"),      nodeChild(before, "SEX"),         nodeChild(after, "SEX"));

  const evTags = new Set([
    ...before.children.filter((c) => INDIVIDUAL_EVENT_TAGS.has(c.tag)).map((c) => c.tag),
    ...after.children.filter((c) => INDIVIDUAL_EVENT_TAGS.has(c.tag)).map((c) => c.tag),
  ]);
  for (const tag of evTags) {
    const label = t(`event.${tag}`);
    check(`${label} ${t("event.colDate")}`,    nodeSub(before, tag, "DATE"), nodeSub(after, tag, "DATE"));
    check(`${label} ${t("event.colPlace")}`,   nodeSub(before, tag, "PLAC"), nodeSub(after, tag, "PLAC"));
    check(`${label} ${t("event.colAddr")}`,    nodeSub(before, tag, "ADDR"), nodeSub(after, tag, "ADDR"));
  }

  return diffs;
}

function diffFamilyNodes(id: string, before: GedNode, after: GedNode, t: Translate): FieldChange[] {
  const diffs: FieldChange[] = [];
  const check = (field: string, from: string, to: string) => {
    if (from !== to) diffs.push({ recordId: id, field, from, to, action: "incoming" });
  };

  const evTags = new Set([
    ...before.children.filter((c) => FAMILY_EVENT_TAGS.has(c.tag)).map((c) => c.tag),
    ...after.children.filter((c) => FAMILY_EVENT_TAGS.has(c.tag)).map((c) => c.tag),
  ]);
  for (const tag of evTags) {
    const label = t(`event.${tag}`);
    check(`${label} ${t("event.colDate")}`,    nodeSub(before, tag, "DATE"), nodeSub(after, tag, "DATE"));
    check(`${label} ${t("event.colPlace")}`,   nodeSub(before, tag, "PLAC"), nodeSub(after, tag, "PLAC"));
    check(`${label} ${t("event.colAddr")}`,    nodeSub(before, tag, "ADDR"), nodeSub(after, tag, "ADDR"));
  }

  return diffs;
}

/**
 * Adds field-level diffs to an edit-mode ChangeReport by comparing pre-edit
 * snapshots against the current dataset. Only existing records have snapshots;
 * newly added records get no field detail (the "New" badge is enough).
 */
export function enrichEditReport(
  report: ChangeReport,
  dataset: Dataset,
  personSnapshots: Map<string, GedNode>,
  familySnapshots: Map<string, GedNode>,
  t: Translate,
): ChangeReport {
  const extra: FieldChange[] = [];

  for (const [id, kind] of Object.entries(report.recordKinds)) {
    if (kind === "individual") {
      const snapshot = personSnapshots.get(id);
      const current = dataset.individuals.get(id);
      if (snapshot && current) extra.push(...diffIndividualNodes(id, snapshot, current.raw, t));
    } else {
      const snapshot = familySnapshots.get(id);
      const current = dataset.families.get(id);
      if (snapshot && current) extra.push(...diffFamilyNodes(id, snapshot, current.raw, t));
    }
  }

  if (extra.length === 0) return report;
  return { ...report, changes: [...report.changes, ...extra] };
}

export function buildEditReport(
  changedPersonIds: Set<string>,
  changedFamilyIds: Set<string>,
  dataset: Dataset,
  loadedPersonIds: Set<string>,
  loadedFamilyIds: Set<string>,
): ChangeReport {
  const changes: FieldChange[] = [];
  const recordLabels: Record<string, string> = {};
  const recordKinds: Record<string, "individual" | "family"> = {};
  let newPersons = 0;
  let newFamilies = 0;

  for (const id of changedPersonIds) {
    const indi = dataset.individuals.get(id);
    const label = indi ? displayName(indi.names[0]) || id : id;
    const isNew = !loadedPersonIds.has(id);
    recordLabels[id] = label;
    recordKinds[id] = "individual";
    changes.push({ recordId: id, field: "", from: "", to: "", action: "incoming", newRecord: isNew });
    if (isNew) newPersons++;
  }

  for (const id of changedFamilyIds) {
    const fam = dataset.families.get(id);
    const husband = fam?.husband ? dataset.individuals.get(fam.husband) : undefined;
    const wife = fam?.wife ? dataset.individuals.get(fam.wife) : undefined;
    const label =
      [husband, wife]
        .filter(Boolean)
        .map((p) => displayName(p!.names[0]))
        .join(" & ") || id;
    const isNew = !loadedFamilyIds.has(id);
    recordLabels[id] = label;
    recordKinds[id] = "family";
    changes.push({ recordId: id, field: "", from: "", to: "", action: "incoming", newRecord: isNew });
    if (isNew) newFamilies++;
  }

  return {
    changes,
    deferred: [],
    recordsChanged: changedPersonIds.size + changedFamilyIds.size,
    newPersons,
    newFamilies,
    placesReformatted: 0,
    placesNoted: 0,
    recordLabels,
    recordKinds,
  };
}

export function combineReports(a: ChangeReport, b: ChangeReport): ChangeReport {
  const changes = [...a.changes, ...b.changes];
  const recordIds = new Set(changes.map((c) => c.recordId));
  return {
    changes,
    deferred: [...a.deferred, ...b.deferred],
    recordsChanged: recordIds.size,
    newPersons: a.newPersons + b.newPersons,
    newFamilies: a.newFamilies + b.newFamilies,
    placesReformatted: a.placesReformatted + b.placesReformatted,
    placesNoted: a.placesNoted + b.placesNoted,
    recordLabels: { ...a.recordLabels, ...b.recordLabels },
    recordKinds: { ...a.recordKinds, ...b.recordKinds },
  };
}

export function removeRecordFromReport(report: ChangeReport, id: string): ChangeReport {
  const removed = report.changes.find((c) => c.recordId === id);
  const changes = report.changes.filter((c) => c.recordId !== id);
  const kind = report.recordKinds[id];
  const recordLabels = { ...report.recordLabels };
  delete recordLabels[id];
  const recordKinds = { ...report.recordKinds };
  delete recordKinds[id];
  const recordIds = new Set(changes.map((c) => c.recordId));
  return {
    ...report,
    changes,
    recordsChanged: recordIds.size,
    newPersons: removed?.newRecord && kind === "individual" ? report.newPersons - 1 : report.newPersons,
    newFamilies: removed?.newRecord && kind === "family" ? report.newFamilies - 1 : report.newFamilies,
    recordLabels,
    recordKinds,
  };
}
