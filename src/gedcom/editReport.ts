import type { Dataset, GedNode } from "./types";
import type { ChangeReport, FieldChange, FamilySpouseInfo } from "../merge/merge";
import { displayName, nameTypeLabel } from "../match/relatives";
import { parseName } from "./name";

type Translate = (key: string, opts?: Record<string, unknown>) => string;

const INDIVIDUAL_EVENT_TAGS = new Set([
  "BIRT", "BAPM", "CHR", "DEAT", "BURI", "CREM", "CONF", "ADOP", "FCOM",
  "OCCU", "EDUC", "RETI", "RESI", "EMIG", "IMMI", "NATU", "CENS", "WILL", "PROB",
]);

const FAMILY_EVENT_TAGS = new Set(["MARR", "ENGA", "SEPA", "DIV"]);

const RECORD_LINK_TAGS = new Set(["WWW", "URL", "_URL", "_WEBTAG"]);

function nodeChild(node: GedNode, tag: string): string {
  return node.children.find((c) => c.tag === tag)?.value?.trim() ?? "";
}

function getNameParts(node: GedNode): { given: string; surname: string; nickname: string } {
  const nameNode = node.children.find((c) => c.tag === "NAME");
  if (!nameNode) return { given: "", surname: "", nickname: "" };
  const subTags = new Map(nameNode.children.map((c) => [c.tag, c.value?.trim() ?? ""]));
  const parsed = parseName(nameNode.value, subTags);
  return { given: parsed.given ?? "", surname: parsed.surname ?? "", nickname: parsed.nickname ?? "" };
}

function displayNameFromRaw(node: GedNode): string {
  const nameNode = node.children.find((c) => c.tag === "NAME");
  if (!nameNode) return "";
  const subTags = new Map(nameNode.children.map((c) => [c.tag, c.value?.trim() ?? ""]));
  return displayName(parseName(nameNode.value, subTags));
}

/** Summaries of every `NAME` record beyond the primary one (married/maiden/aka/…). */
function additionalNameSummaries(node: GedNode, t: Translate): string[] {
  return node.children
    .filter((c) => c.tag === "NAME")
    .slice(1)
    .map((n) => {
      const subTags = new Map(n.children.map((c) => [c.tag, c.value?.trim() ?? ""]));
      const label = displayName(parseName(n.value, subTags));
      const type = subTags.get("TYPE");
      return type ? `${nameTypeLabel(type, t)}: ${label}` : label;
    });
}

function diffAdditionalNames(id: string, before: GedNode, after: GedNode, t: Translate): FieldChange[] {
  const diffs: FieldChange[] = [];
  const beforeNames = additionalNameSummaries(before, t);
  const afterNames = additionalNameSummaries(after, t);
  const fieldLabel = t("field.additionalNames");
  for (const v of beforeNames) {
    if (!afterNames.includes(v)) diffs.push({ recordId: id, field: fieldLabel, from: v, to: "", action: "incoming" });
  }
  for (const v of afterNames) {
    if (!beforeNames.includes(v)) diffs.push({ recordId: id, field: fieldLabel, from: "", to: v, action: "both" });
  }
  return diffs;
}

function summarizeEvent(node: GedNode): string {
  const get = (tag: string) => node.children.find((c) => c.tag === tag)?.value?.trim() ?? "";
  return [get("DATE"), get("PLAC"), get("ADDR"), get("NOTE")].filter(Boolean).join(" · ") || "…";
}

function diffEventSet(
  id: string,
  before: GedNode,
  after: GedNode,
  tags: Set<string>,
  label: (tag: string) => string,
): FieldChange[] {
  const diffs: FieldChange[] = [];
  for (const tag of tags) {
    const beforeSummaries = before.children.filter((c) => c.tag === tag).map(summarizeEvent);
    const afterSummaries  = after.children.filter((c) => c.tag === tag).map(summarizeEvent);
    const fieldLabel = label(tag);
    for (const s of beforeSummaries) {
      if (!afterSummaries.includes(s))
        diffs.push({ recordId: id, field: fieldLabel, from: s, to: "", action: "incoming" });
    }
    for (const s of afterSummaries) {
      if (!beforeSummaries.includes(s))
        diffs.push({ recordId: id, field: fieldLabel, from: "", to: s, action: "both" });
    }
  }
  return diffs;
}

function diffStringSet(
  id: string,
  before: GedNode,
  after: GedNode,
  tagFilter: (tag: string) => boolean,
  fieldLabel: string,
): FieldChange[] {
  const diffs: FieldChange[] = [];
  const beforeVals = before.children.filter((c) => tagFilter(c.tag)).map((c) => c.value?.trim() ?? "").filter(Boolean);
  const afterVals  = after.children.filter((c) => tagFilter(c.tag)).map((c) => c.value?.trim() ?? "").filter(Boolean);
  for (const v of beforeVals) {
    if (!afterVals.includes(v)) diffs.push({ recordId: id, field: fieldLabel, from: v, to: "", action: "incoming" });
  }
  for (const v of afterVals) {
    if (!beforeVals.includes(v)) diffs.push({ recordId: id, field: fieldLabel, from: "", to: v, action: "both" });
  }
  return diffs;
}

function diffIndividualNodes(id: string, before: GedNode, after: GedNode, t: Translate): FieldChange[] {
  const diffs: FieldChange[] = [];
  const check = (field: string, from: string, to: string) => {
    if (from !== to) diffs.push({ recordId: id, field, from, to, action: "incoming" });
  };

  const beforeName = getNameParts(before);
  const afterName = getNameParts(after);
  check(t("field.given"),   beforeName.given,    afterName.given);
  check(t("field.surname"),  beforeName.surname,  afterName.surname);
  check(t("field.nickname"), beforeName.nickname, afterName.nickname);
  check(t("field.sex"),      nodeChild(before, "SEX"), nodeChild(after, "SEX"));
  diffs.push(...diffAdditionalNames(id, before, after, t));

  const evTags = new Set([
    ...before.children.filter((c) => INDIVIDUAL_EVENT_TAGS.has(c.tag)).map((c) => c.tag),
    ...after.children.filter((c) => INDIVIDUAL_EVENT_TAGS.has(c.tag)).map((c) => c.tag),
  ]);
  diffs.push(...diffEventSet(id, before, after, evTags, (tag) => t(`event.${tag}`)));
  diffs.push(...diffStringSet(id, before, after, (tag) => tag === "NOTE", t("field.notes")));
  diffs.push(...diffStringSet(id, before, after, (tag) => RECORD_LINK_TAGS.has(tag), t("field.sources")));

  return diffs;
}

function diffFamilyNodes(id: string, before: GedNode, after: GedNode, t: Translate): FieldChange[] {
  const diffs: FieldChange[] = [];

  const evTags = new Set([
    ...before.children.filter((c) => FAMILY_EVENT_TAGS.has(c.tag)).map((c) => c.tag),
    ...after.children.filter((c) => FAMILY_EVENT_TAGS.has(c.tag)).map((c) => c.tag),
  ]);
  diffs.push(...diffEventSet(id, before, after, evTags, (tag) => t(`event.${tag}`)));
  diffs.push(...diffStringSet(id, before, after, (tag) => tag === "NOTE", t("field.notes")));
  diffs.push(...diffStringSet(id, before, after, (tag) => RECORD_LINK_TAGS.has(tag), t("field.sources")));

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
      if (snapshot && current) {
        extra.push(...diffIndividualNodes(id, snapshot, current.raw, t));
      } else if (snapshot && !current) {
        // Deleted person: list which families they belonged to
        for (const node of snapshot.children) {
          if (node.tag === "FAMC" || node.tag === "FAMS") {
            const famId = node.value?.trim();
            if (!famId) continue;
            const famLabel = report.recordLabels[famId] ?? famId;
            const fieldKey = node.tag === "FAMC" ? "field.childOf" : "field.spouseOf";
            extra.push({ recordId: id, field: t(fieldKey), from: famLabel, to: "", action: "incoming" });
          }
        }
      }
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
  personSnapshots?: Map<string, GedNode>,
  familySnapshots?: Map<string, GedNode>,
): ChangeReport {
  const changes: FieldChange[] = [];
  const recordLabels: Record<string, string> = {};
  const recordKinds: Record<string, "individual" | "family"> = {};
  const familySpouses: Record<string, FamilySpouseInfo[]> = {};
  let newPersons = 0;
  let newFamilies = 0;

  for (const id of changedPersonIds) {
    const indi = dataset.individuals.get(id);
    const isNew = !loadedPersonIds.has(id);
    const isRemoved = !indi && !isNew;
    let label: string;
    if (indi) {
      label = displayName(indi.names[0]) || id;
    } else {
      const snap = personSnapshots?.get(id);
      label = snap ? displayNameFromRaw(snap) || id : id;
    }
    recordLabels[id] = label;
    recordKinds[id] = "individual";
    changes.push({ recordId: id, field: "", from: "", to: "", action: "incoming", newRecord: isNew, removedRecord: isRemoved });
    if (isNew) newPersons++;
  }

  // Helper to resolve an individual's display name from dataset or snapshots
  const resolveIndiName = (indiId: string | undefined): string | undefined => {
    if (!indiId) return undefined;
    const indi = dataset.individuals.get(indiId);
    if (indi) return displayName(indi.names[0]) || undefined;
    const snap = personSnapshots?.get(indiId);
    return snap ? displayNameFromRaw(snap) || undefined : undefined;
  };

  for (const id of changedFamilyIds) {
    const fam = dataset.families.get(id);
    const famSnap = familySnapshots?.get(id);
    // Prefer current fam's HUSB/WIFE; fall back to snapshot xrefs if member was deleted
    const husbandId = fam?.husband ?? famSnap?.children.find((c) => c.tag === "HUSB")?.value?.trim();
    const wifeId = fam?.wife ?? famSnap?.children.find((c) => c.tag === "WIFE")?.value?.trim();
    const entries: FamilySpouseInfo[] = [];
    for (const spouseId of [husbandId, wifeId]) {
      const name = resolveIndiName(spouseId);
      if (name) entries.push({ id: spouseId, name });
    }
    const isNew = !loadedFamilyIds.has(id);
    recordLabels[id] = entries.map((e) => e.name).join(" + ") || id;
    recordKinds[id] = "family";
    if (entries.length) familySpouses[id] = entries;
    changes.push({ recordId: id, field: "", from: "", to: "", action: "incoming", newRecord: isNew });
    if (isNew) newFamilies++;
  }

  return {
    changes,
    deferred: [],
    recordsChanged: changedPersonIds.size + changedFamilyIds.size,
    newPersons,
    newFamilies,
    recordLabels,
    recordKinds,
    familySpouses,
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
    recordLabels: { ...a.recordLabels, ...b.recordLabels },
    recordKinds: { ...a.recordKinds, ...b.recordKinds },
    familySpouses: { ...a.familySpouses, ...b.familySpouses },
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
  const familySpouses = { ...report.familySpouses };
  delete familySpouses[id];
  const recordIds = new Set(changes.map((c) => c.recordId));
  return {
    ...report,
    changes,
    recordsChanged: recordIds.size,
    newPersons: removed?.newRecord && kind === "individual" ? report.newPersons - 1 : report.newPersons,
    newFamilies: removed?.newRecord && kind === "family" ? report.newFamilies - 1 : report.newFamilies,
    recordLabels,
    recordKinds,
    familySpouses,
  };
}
