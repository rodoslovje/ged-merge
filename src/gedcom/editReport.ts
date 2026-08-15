import { EDITABLE_FAM_EVENT_TAGS, INDI_EVENT_TAG_ORDER } from "./eventTags";
import type { Dataset, GedNode } from "./types";
import type { ChangeReport, FieldChange, FamilySpouseInfo } from "../merge/merge";
import { displayName, nameTypeLabel } from "../match/relatives";
import { childrenByTag, firstChild, nodesEqual } from "./node";
import { parseName } from "./name";
import { placeNodeCoord } from "./place";
import { buildObjeIndex, isPointer, objeInfoOf, sourceTitle } from "./source";
import { xrefLabel } from "./nameDisplay";
import type { Translate } from "../locales/i18n";

/** Individual events the report diffs — the canonical set minus MARR, which
 *  the individual editor doesn't surface. */
const INDIVIDUAL_EVENT_TAGS = new Set(INDI_EVENT_TAG_ORDER);

const FAMILY_EVENT_TAGS = new Set(EDITABLE_FAM_EVENT_TAGS);

const RECORD_LINK_TAGS = new Set(["WWW", "URL", "_URL", "_WEBTAG"]);

/** Record children handled by their own dedicated diff passes (names, notes,
 *  links, citations, media, memberships, audit stamps) — never diffed as
 *  events, whatever their substructure. */
const NON_EVENT_TAGS = new Set([
  "NAME", "SEX", "NOTE", "SOUR", "OBJE", "FAMS", "FAMC", "HUSB", "WIFE", "CHIL",
  "CHAN", "CREA", "RESN", "RIN", "SUBM", "ASSO", "ALIA", "ANCI", "DESI",
  ...RECORD_LINK_TAGS,
]);

/** Substructure that marks a child as event-shaped. Any tag outside the
 *  canonical event lists that carries one of these (CHRA, BAPL, MARB/MARL,
 *  vendor events, …) is still diffed as an event — bulk tools (geocode,
 *  place rename) write into every PLAC, so a whitelist here would let those
 *  changes silently vanish from the save preview. */
const EVENT_SHAPE_TAGS = new Set(["DATE", "PLAC", "ADDR", "TYPE", "CAUS", "AGNC"]);

function isEventShaped(node: GedNode): boolean {
  return node.children.some((c) => EVENT_SHAPE_TAGS.has(c.tag));
}

/** Tags to diff as events on a record: the known set, plus anything
 *  event-shaped that no dedicated pass owns. */
function eventTagsOf(before: GedNode, after: GedNode, known: Set<string>): Set<string> {
  const isEvent = (c: GedNode) => known.has(c.tag) || (!NON_EVENT_TAGS.has(c.tag) && isEventShaped(c));
  return new Set([...before.children, ...after.children].filter(isEvent).map((c) => c.tag));
}

function nodeChild(node: GedNode, tag: string): string {
  return node.children.find((c) => c.tag === tag)?.value?.trim() ?? "";
}

function getNameParts(node: GedNode): { given: string; surname: string; nickname: string } {
  const nameNode = firstChild(node, "NAME");
  if (!nameNode) return { given: "", surname: "", nickname: "" };
  const subTags = new Map(nameNode.children.map((c) => [c.tag, c.value?.trim() ?? ""]));
  const parsed = parseName(nameNode.value, subTags);
  return { given: parsed.given ?? "", surname: parsed.surname ?? "", nickname: parsed.nickname ?? "" };
}

function displayNameFromRaw(node: GedNode): string {
  const nameNode = firstChild(node, "NAME");
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

/** One-line description of a `SOUR` citation node — the cited record's title
 *  (or the inline citation text) plus the cited page. Pointers resolve through
 *  the *current* records, mirroring the media resolver's caveat. */
type SourceResolver = (node: GedNode) => string | undefined;

function makeSourceResolver(records: GedNode[]): SourceResolver {
  const titles = new Map<string, string>();
  for (const r of records) {
    if (r.tag !== "SOUR" || !r.xref) continue;
    const title = r.children.find((c) => c.tag === "TITL")?.value?.trim();
    if (title) titles.set(r.xref, title);
  }
  return (node) => {
    const v = node.value?.trim();
    if (!v) return undefined;
    const base = isPointer(v) ? titles.get(v) ?? v : v;
    const page = node.children.find((c) => c.tag === "PAGE")?.value?.trim();
    return page ? `${base} (${page})` : base;
  };
}

/** Diff a record's own `SOUR` citations, describing each added/removed one by
 *  its source title + page rather than the raw pointer. Multiset semantics —
 *  two citations of the same source/page are two entries. */
function diffSourceCitations(id: string, before: GedNode, after: GedNode, fieldLabel: string, resolve: SourceResolver): FieldChange[] {
  const lines = (node: GedNode) => childrenByTag(node, "SOUR").map(resolve).filter((s): s is string => !!s);
  const beforeVals = lines(before);
  const afterVals = lines(after);
  const diffs: FieldChange[] = [];
  const unmatchedAfter = [...afterVals];
  for (const v of beforeVals) {
    const i = unmatchedAfter.indexOf(v);
    if (i !== -1) unmatchedAfter.splice(i, 1);
    else diffs.push({ recordId: id, field: fieldLabel, from: v, to: "", action: "incoming" });
  }
  const unmatchedBefore = [...beforeVals];
  for (const v of afterVals) {
    const i = unmatchedBefore.indexOf(v);
    if (i !== -1) unmatchedBefore.splice(i, 1);
    else diffs.push({ recordId: id, field: fieldLabel, from: "", to: v, action: "both" });
  }
  return diffs;
}

/** An event's sub-fields kept apart (rather than joined into one display string)
 *  so a modified — not newly added/removed — event can be diffed field by field. */
interface EventFields {
  type: string;
  value: string;
  date: string;
  place: string;
  coord: string;
  addr: string;
  note: string;
  cause: string;
  sources: string;
}

const EVENT_FIELD_KEYS: (keyof EventFields)[] = ["type", "value", "date", "place", "coord", "addr", "note", "cause", "sources"];

/** The location-ish sub-fields, kept in one place so the "same event, moved"
 *  pairing pass below stays in sync when another location field is added. */
const PLACE_FIELD_KEYS: (keyof EventFields)[] = ["place", "coord", "addr"];

/** Keys that count towards "same event" pairing. `coord` is excluded: it is
 *  derived from the place, and after bulk geocoding many distinct PLAC
 *  strings share one village coordinate — a coord-only match must not glue
 *  two unrelated events into one "modified" row. */
const OVERLAP_KEYS = EVENT_FIELD_KEYS.filter((k) => k !== "coord");

/** The place's MAP coordinate as a display string ("46.0511, 14.5051"), so a
 *  geocode write-back (MAP LATI/LONG added under an existing PLAC) shows in
 *  the diff instead of silently disappearing. */
function placeCoord(node: GedNode): string {
  const plac = firstChild(node, "PLAC");
  const coord = plac && placeNodeCoord(plac);
  return coord ? `${coord.lat.toFixed(4)}, ${coord.lon.toFixed(4)}` : "";
}

function eventFields(node: GedNode, resolveSource: SourceResolver): EventFields {
  const get = (tag: string) => node.children.find((c) => c.tag === tag)?.value?.trim() ?? "";
  // node.value carries the event's own title (e.g. "1 OCCU Engineer") for
  // tags like OCCU/EDUC/RETI — include it or a title-only edit won't change
  // the summary and the diff silently drops the change. Citations are part of
  // the summary for the same reason — adding a source to an event must show.
  const sources = childrenByTag(node, "SOUR").map(resolveSource).filter(Boolean).join(", ");
  return { type: get("TYPE"), value: node.value?.trim() ?? "", date: get("DATE"), place: get("PLAC"), coord: placeCoord(node), addr: get("ADDR"), note: get("NOTE"), cause: get("CAUS"), sources };
}

function eventSummary(f: EventFields): string {
  return EVENT_FIELD_KEYS.map((k) => f[k]).filter(Boolean).join(" · ") || "…";
}

/** Count of sub-fields two event instances share — used to recognize a before/after
 *  pair as "the same event, modified" rather than an unrelated add+remove pair. */
function eventOverlapScore(a: EventFields, b: EventFields): number {
  return OVERLAP_KEYS.reduce((n, k) => n + (a[k] && a[k] === b[k] ? 1 : 0), 0);
}

/** Builds the segmented diff for one event instance that was modified in place:
 *  each present sub-field is marked "changed" (highlighted), "same" (left in its
 *  normal incoming-data color), or "removed" (struck through) — instead of treating
 *  the whole event summary as one freshly added/removed value. */
function diffEventOccurrence(id: string, before: EventFields, after: EventFields, fieldLabel: string): FieldChange {
  const segments: FieldChange["segments"] = [];
  for (const k of EVENT_FIELD_KEYS) {
    if (after[k])
      segments.push({
        text: after[k],
        state: after[k] === before[k] ? "same" : "changed",
        // What is being given up, where the piece replaced something: a place
        // rewritten to the register's wording read as a plain green line, with
        // no way to see what it had been.
        ...(before[k] && before[k] !== after[k] ? { from: before[k] } : {}),
      });
    else if (before[k]) segments.push({ text: before[k], state: "removed" });
  }
  return { recordId: id, field: fieldLabel, from: eventSummary(before), to: eventSummary(after), action: "both", group: fieldLabel, segments };
}

function diffEventSet(
  id: string,
  before: GedNode,
  after: GedNode,
  tags: Set<string>,
  label: (tag: string) => string,
  resolveSource: SourceResolver,
): FieldChange[] {
  const diffs: FieldChange[] = [];
  for (const tag of tags) {
    const beforeFields = before.children.filter((c) => c.tag === tag).map((c) => eventFields(c, resolveSource));
    const afterFields  = after.children.filter((c) => c.tag === tag).map((c) => eventFields(c, resolveSource));
    const fieldLabel = label(tag);
    const usedB = new Set<number>();
    const usedA = new Set<number>();

    // Exact matches are unchanged events — drop them before pairing the rest.
    for (let bi = 0; bi < beforeFields.length; bi++) {
      for (let ai = 0; ai < afterFields.length; ai++) {
        if (usedA.has(ai)) continue;
        if (eventSummary(beforeFields[bi]) === eventSummary(afterFields[ai])) {
          usedB.add(bi); usedA.add(ai);
          break;
        }
      }
    }

    // Among what's left, greedily pair instances that still share a sub-field —
    // that's the same event with an edit, not an unrelated add+remove.
    const candidates: { bi: number; ai: number; score: number }[] = [];
    for (let bi = 0; bi < beforeFields.length; bi++) {
      if (usedB.has(bi)) continue;
      for (let ai = 0; ai < afterFields.length; ai++) {
        if (usedA.has(ai)) continue;
        const score = eventOverlapScore(beforeFields[bi], afterFields[ai]);
        if (score >= 1) candidates.push({ bi, ai, score });
      }
    }
    candidates.sort((x, y) => y.score - x.score);
    for (const { bi, ai } of candidates) {
      if (usedB.has(bi) || usedA.has(ai)) continue;
      usedB.add(bi); usedA.add(ai);
      diffs.push(diffEventOccurrence(id, beforeFields[bi], afterFields[ai], fieldLabel));
    }

    // Secondary pass: pair place/addr-only events where all other sub-fields
    // agree (including both empty). eventOverlapScore requires a truthy match,
    // so place-only events score 0 and miss the first pass — but they are
    // clearly the same event with an edited location, not a remove+add pair.
    const nonPlaceKeys = EVENT_FIELD_KEYS.filter((k) => !PLACE_FIELD_KEYS.includes(k));
    for (let bi = 0; bi < beforeFields.length; bi++) {
      if (usedB.has(bi)) continue;
      for (let ai = 0; ai < afterFields.length; ai++) {
        if (usedA.has(ai)) continue;
        if (nonPlaceKeys.every(k => beforeFields[bi][k] === afterFields[ai][k])) {
          usedB.add(bi); usedA.add(ai);
          diffs.push(diffEventOccurrence(id, beforeFields[bi], afterFields[ai], fieldLabel));
          break;
        }
      }
    }

    // Whatever's still unmatched is a genuine removal or a genuine new event.
    for (let bi = 0; bi < beforeFields.length; bi++) {
      if (usedB.has(bi)) continue;
      diffs.push({ recordId: id, field: fieldLabel, from: eventSummary(beforeFields[bi]), to: "", action: "incoming", group: fieldLabel });
    }
    for (let ai = 0; ai < afterFields.length; ai++) {
      if (usedA.has(ai)) continue;
      diffs.push({ recordId: id, field: fieldLabel, from: "", to: eventSummary(afterFields[ai]), action: "both", group: fieldLabel });
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
  asLinks = false,
): FieldChange[] {
  const diffs: FieldChange[] = [];
  const beforeVals = before.children.filter((c) => tagFilter(c.tag)).map((c) => c.value?.trim() ?? "").filter(Boolean);
  const afterVals  = after.children.filter((c) => tagFilter(c.tag)).map((c) => c.value?.trim() ?? "").filter(Boolean);
  for (const v of beforeVals) {
    if (!afterVals.includes(v)) diffs.push({ recordId: id, field: fieldLabel, from: v, to: "", action: "incoming" });
  }
  const added = afterVals.filter((v) => !beforeVals.includes(v));
  if (asLinks) {
    // Render added record-level links as the same 🔗 icons (with the URL as a
    // tooltip) the main UI uses, rather than a separate "+ url" text row.
    if (added.length) diffs.push({ recordId: id, field: fieldLabel, from: "", to: "", action: "both", links: added });
  } else {
    for (const v of added) {
      diffs.push({ recordId: id, field: fieldLabel, from: "", to: v, action: "both" });
    }
  }
  return diffs;
}

/** A photo's full file path plus a one-line summary of its descriptive
 *  metadata (title/date/place/description), used to detect added/removed/edited
 *  photos in the diff. */
interface MediaDesc {
  path: string;
  meta: string;
}

/**
 * A resolver from a record's `OBJE` child to its {@link MediaDesc} — read from
 * the inline node, or (for a `@O@` pointer) the shared record's content via
 * `objeIndex`. URL-only objects (web links, not photos) and unresolvable
 * pointers (e.g. a shared record pruned on removal) return undefined.
 *
 * Note: a pointer resolves through the *current* records on both sides of the
 * diff, so a metadata-only edit to a shared `OBJE` isn't detectable here — only
 * inline photos surface metadata changes.
 */
type MediaResolver = (node: GedNode) => MediaDesc | undefined;

function makeMediaResolver(records: GedNode[]): MediaResolver {
  const objeIndex = buildObjeIndex(records);
  return (node) => {
    const ptr = node.value?.trim();
    const info = ptr && isPointer(ptr) ? objeIndex.get(ptr) : objeInfoOf(node);
    if (!info || !info.file || info.url) return undefined;
    const meta = [info.title, info.date, info.place, info.description].filter(Boolean).join(" · ");
    return { path: info.file, meta };
  };
}

/** Diff a record's photos (`OBJE`), reporting each one added, removed, or (for
 *  inline photos) edited, as a self-describing one-liner — `path` plus its
 *  metadata. Rows are `noLabel`, so the preview shows them without a prefix. */
function diffMedia(id: string, before: GedNode, after: GedNode, fieldLabel: string, resolve: MediaResolver): FieldChange[] {
  const descs = (node: GedNode) =>
    childrenByTag(node, "OBJE").map(resolve).filter((d): d is MediaDesc => !!d);
  const beforeByPath = new Map(descs(before).map((d) => [d.path, d]));
  const afterByPath = new Map(descs(after).map((d) => [d.path, d]));
  const line = (d: MediaDesc) => (d.meta ? `${d.path} — ${d.meta}` : d.path);
  const diffs: FieldChange[] = [];
  for (const [path, d] of beforeByPath) {
    if (!afterByPath.has(path)) diffs.push({ recordId: id, field: fieldLabel, from: line(d), to: "", action: "incoming", noLabel: true });
  }
  for (const [path, d] of afterByPath) {
    const prev = beforeByPath.get(path);
    if (!prev) diffs.push({ recordId: id, field: fieldLabel, from: "", to: line(d), action: "both", noLabel: true });
    else if (prev.meta !== d.meta) diffs.push({ recordId: id, field: fieldLabel, from: "", to: line(d), action: "both", noLabel: true });
  }
  return diffs;
}

function diffIndividualNodes(id: string, before: GedNode, after: GedNode, t: Translate, resolveMedia: MediaResolver, resolveSource: SourceResolver): FieldChange[] {
  const diffs: FieldChange[] = [];
  const check = (field: string, from: string, to: string, identity?: boolean) => {
    if (from !== to) diffs.push({ recordId: id, field, from, to, action: "incoming", identity });
  };

  const beforeName = getNameParts(before);
  const afterName = getNameParts(after);
  check(t("field.given"),   beforeName.given,    afterName.given,    true);
  check(t("field.surname"),  beforeName.surname,  afterName.surname,  true);
  check(t("field.nickname"), beforeName.nickname, afterName.nickname);
  check(t("field.sex"),      nodeChild(before, "SEX"), nodeChild(after, "SEX"), true);
  diffs.push(...diffAdditionalNames(id, before, after, t));

  const evTags = eventTagsOf(before, after, INDIVIDUAL_EVENT_TAGS);
  diffs.push(...diffEventSet(id, before, after, evTags, (tag) => t(`event.${tag}`, { defaultValue: tag }), resolveSource));
  diffs.push(...diffStringSet(id, before, after, (tag) => tag === "NOTE", t("field.notes")));
  diffs.push(...diffStringSet(id, before, after, (tag) => tag === "_FID" || tag === "_FSFTID", t("field.fsid")));
  diffs.push(...diffStringSet(id, before, after, (tag) => RECORD_LINK_TAGS.has(tag), t("field.sources"), true));
  diffs.push(...diffSourceCitations(id, before, after, t("field.sources"), resolveSource));
  diffs.push(...diffMedia(id, before, after, t("field.media"), resolveMedia));

  return diffs;
}

/** Diffs a family's HUSB/WIFE/CHIL pointers, reporting members added or removed
 *  (e.g. by deleting a person, or detaching/connecting a relative) by display name. */
function diffFamilyMembership(
  id: string,
  before: GedNode,
  after: GedNode,
  t: Translate,
  resolveName: (xref: string) => string,
): FieldChange[] {
  const diffs: FieldChange[] = [];

  for (const [tag, fieldKey] of [["HUSB", "field.husband"], ["WIFE", "field.wife"]] as const) {
    const beforeVal = nodeChild(before, tag);
    const afterVal = nodeChild(after, tag);
    if (beforeVal === afterVal) continue;
    const fieldLabel = t(fieldKey);
    if (beforeVal) diffs.push({ recordId: id, field: fieldLabel, from: resolveName(beforeVal), to: "", action: "incoming" });
    if (afterVal) diffs.push({ recordId: id, field: fieldLabel, from: "", to: resolveName(afterVal), action: "both" });
  }

  const beforeChildren = childrenByTag(before, "CHIL").map((c) => c.value?.trim() ?? "").filter(Boolean);
  const afterChildren = childrenByTag(after, "CHIL").map((c) => c.value?.trim() ?? "").filter(Boolean);
  for (const cid of beforeChildren) {
    if (!afterChildren.includes(cid)) diffs.push({ recordId: id, field: t("field.child"), from: resolveName(cid), to: "", action: "incoming" });
  }
  for (const cid of afterChildren) {
    if (!beforeChildren.includes(cid)) diffs.push({ recordId: id, field: t("field.child"), from: "", to: resolveName(cid), action: "both" });
  }

  return diffs;
}

function diffFamilyNodes(
  id: string,
  before: GedNode,
  after: GedNode,
  t: Translate,
  resolveName: (xref: string) => string,
  resolveMedia: MediaResolver,
  resolveSource: SourceResolver,
): FieldChange[] {
  const diffs: FieldChange[] = [];

  diffs.push(...diffFamilyMembership(id, before, after, t, resolveName));

  const evTags = eventTagsOf(before, after, FAMILY_EVENT_TAGS);
  diffs.push(...diffEventSet(id, before, after, evTags, (tag) => t(`event.${tag}`, { defaultValue: tag }), resolveSource));
  diffs.push(...diffStringSet(id, before, after, (tag) => tag === "NOTE", t("field.notes")));
  diffs.push(...diffStringSet(id, before, after, (tag) => RECORD_LINK_TAGS.has(tag), t("field.sources"), true));
  diffs.push(...diffSourceCitations(id, before, after, t("field.sources"), resolveSource));
  diffs.push(...diffMedia(id, before, after, t("field.media"), resolveMedia));

  return diffs;
}

/**
 * When a FAMS/FAMC link is lost because its family was removed, find the
 * surviving family the relationship was folded into (during a duplicate merge,
 * two records for the same couple collapse into one). The fold target is the
 * surviving family — of the same role — that absorbed the most of the dropped
 * family's other members. Returns undefined for a genuine loss (no replacement).
 */
function findFoldTarget(
  id: string,
  droppedSnap: GedNode | undefined,
  tag: "FAMS" | "FAMC",
  dataset: Dataset,
): string | undefined {
  if (!droppedSnap) return undefined;
  const indi = dataset.individuals.get(id);
  if (!indi) return undefined;
  const others = new Set(
    droppedSnap.children
      .filter((c) => c.tag === "HUSB" || c.tag === "WIFE" || c.tag === "CHIL")
      .map((c) => c.value?.trim())
      .filter((v): v is string => !!v && v !== id),
  );
  if (others.size === 0) return undefined;
  let best: string | undefined;
  let bestScore = 0;
  for (const node of indi.raw.children) {
    if (node.tag !== tag) continue;
    const fid = node.value?.trim();
    if (!fid) continue;
    const fam = dataset.families.get(fid);
    if (!fam) continue;
    const members = new Set([fam.husband, fam.wife, ...fam.children].filter((m): m is string => !!m));
    let score = 0;
    for (const m of others) if (members.has(m)) score++;
    if (score > bestScore) { bestScore = score; best = fid; }
  }
  return best;
}

/** "Husband + Wife" label for a current family, resolving names from the dataset. */
function currentFamilyLabel(famId: string, dataset: Dataset, resolveName: (xref: string) => string): string {
  const fam = dataset.families.get(famId);
  if (!fam) return famId;
  const names = [fam.husband, fam.wife].filter((m): m is string => !!m).map(resolveName).filter(Boolean);
  return names.join(" + ") || famId;
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
  const resolveMedia = makeMediaResolver(dataset.records);
  const resolveSource = makeSourceResolver(dataset.records);

  const resolveIndiName = (xref: string): string => {
    const indi = dataset.individuals.get(xref);
    if (indi) return displayName(indi.names[0]) || xref;
    const snap = personSnapshots.get(xref);
    return snap ? displayNameFromRaw(snap) || xref : xref;
  };

  for (const [id, kind] of Object.entries(report.recordKinds)) {
    if (kind === "individual") {
      const snapshot = personSnapshots.get(id);
      const current = dataset.individuals.get(id);
      if (snapshot && current) {
        extra.push(...diffIndividualNodes(id, snapshot, current.raw, t, resolveMedia, resolveSource));
        // Family-membership changes on the individual. A detach from a family
        // that still exists is shown on that family's row, so only removed
        // families (pruned, or folded away by a duplicate merge) surface as a
        // loss here. Gained memberships are reported too — otherwise a survivor
        // that only absorbed a re-pointed relationship is flagged "changed" with
        // nothing listed.
        for (const tag of ["FAMS", "FAMC"] as const) {
          const fieldKey = tag === "FAMC" ? "field.childOf" : "field.spouseOf";
          const linkVals = (node: GedNode) =>
            node.children.filter((c) => c.tag === tag).map((c) => c.value?.trim()).filter((v): v is string => !!v);
          const beforeLinks = linkVals(snapshot);
          const afterSet = new Set(linkVals(current.raw));
          const beforeSet = new Set(beforeLinks);
          const gained = new Set([...afterSet].filter((f) => !beforeSet.has(f)));
          for (const famId of beforeLinks) {
            if (afterSet.has(famId) || dataset.families.has(famId)) continue;
            const famLabel = report.recordLabels[famId] ?? famId;
            // If the relationship survived in another family (a duplicate merge
            // folded two records for the same couple into one), report it as a
            // move so the preview doesn't read as the relationship vanishing.
            const target = findFoldTarget(id, familySnapshots.get(famId), tag, dataset);
            if (target) {
              gained.delete(target); // the move already accounts for this new membership
              extra.push({ recordId: id, field: t(fieldKey), from: famLabel, to: currentFamilyLabel(target, dataset, resolveIndiName), action: "incoming" });
            } else {
              extra.push({ recordId: id, field: t(fieldKey), from: famLabel, to: "", action: "incoming" });
            }
          }
          for (const famId of gained) {
            extra.push({ recordId: id, field: t(fieldKey), from: "", to: currentFamilyLabel(famId, dataset, resolveIndiName), action: "both" });
          }
        }
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
      if (snapshot && current) extra.push(...diffFamilyNodes(id, snapshot, current.raw, t, resolveIndiName, resolveMedia, resolveSource));
    }
  }

  if (extra.length === 0) return report;
  return { ...report, changes: [...report.changes, ...extra] };
}

/**
 * Heading for a top-level shared record in the report: its own title when it has
 * one (a source's TITL, a media object's title), otherwise `TAG xref` — a SOUR
 * or OBJE has no name to fall back on the way a person does. A source and its
 * page-image media record often share one title (the OBJE is titled after the
 * source it backs), so each carries its kind icon — 📖 source, 🔗/🖼 media,
 * 🏛 repository, the same glyphs the Sources tool uses — to keep the rows apart.
 */
export function sharedRecordLabel(id: string, node: GedNode | undefined): string {
  if (!node) return xrefLabel(id);
  const icon = node.tag === "SOUR" ? "📖" : node.tag === "OBJE" ? (objeInfoOf(node).url ? "🔗" : "🖼") : node.tag === "REPO" ? "🏛" : undefined;
  const title =
    node.tag === "SOUR" ? sourceTitle(node)
    : node.tag === "OBJE" ? objeInfoOf(node).title
    : node.tag === "REPO" ? firstChild(node, "NAME")?.value
    : undefined;
  const label = title?.trim() || `${node.tag} ${xrefLabel(id)}`;
  return icon ? `${icon} ${label}` : label;
}

/** The same record with nothing in it — what a brand-new record is diffed
 *  against, so every line it brought reads as added. */
export function emptyLike(node: GedNode): GedNode {
  return { level: node.level, tag: node.tag, children: [] };
}

/** A line whose whole value is a pointer at another record. */
const POINTER = /^@[^@\s]+@$/;

/**
 * Name the record a pointer points at, the way the app names it everywhere
 * else. `1 REPO @R1@` is an archive with a name, and printing the xref instead
 * hands the reader a lookup to do by hand in a file they can't search.
 *
 * The xref index is built on first use, so a save that turns out to have no
 * pointers to resolve pays nothing for it.
 */
export function makeXrefLabeler(records: GedNode[]): (xref: string) => string | undefined {
  let index: Map<string, GedNode> | undefined;
  const label = (xref: string): string | undefined => {
    if (!index) {
      index = new Map();
      for (const r of records) if (r.xref) index.set(r.xref, r);
    }
    const node = index.get(xref);
    if (!node) return undefined; // a dangling pointer stays raw — the xref is the finding
    if (node.tag === "INDI") return displayNameFromRaw(node) || undefined;
    if (node.tag === "FAM") {
      const spouses = ["HUSB", "WIFE"]
        .map((tag) => firstChild(node, tag)?.value?.trim())
        .filter((x): x is string => !!x)
        .map((x) => label(x) ?? x);
      return spouses.join(" + ") || undefined;
    }
    return sharedRecordLabel(xref, node);
  };
  return label;
}

/**
 * Value-level diff of a shared record (SOUR/OBJE/NOTE), which has no typed
 * projection to compare the way individuals and families do. Both trees are
 * flattened to `TAG.SUBTAG` → values in document order and compared position by
 * position, so a repaired `DATE` reads "DATA.DATE: Apr 12, 1979 → 12 APR 1979".
 *
 * @param labelFor names the target of a pointer value (see {@link makeXrefLabeler}).
 */
export function diffSharedRecordNodes(
  id: string,
  before: GedNode,
  after: GedNode,
  labelFor?: (xref: string) => string | undefined,
): FieldChange[] {
  const show = (value: string) =>
    labelFor && POINTER.test(value) ? labelFor(value) ?? value : value;
  const flatten = (node: GedNode, prefix: string, out: Map<string, string[]>) => {
    for (const child of node.children) {
      const path = prefix ? `${prefix}.${child.tag}` : child.tag;
      const value = child.value?.trim();
      if (value) {
        const list = out.get(path);
        if (list) list.push(value);
        else out.set(path, [value]);
      }
      flatten(child, path, out);
    }
  };
  const beforeVals = new Map<string, string[]>();
  const afterVals = new Map<string, string[]>();
  flatten(before, "", beforeVals);
  flatten(after, "", afterVals);

  const changes: FieldChange[] = [];
  for (const path of new Set([...beforeVals.keys(), ...afterVals.keys()])) {
    const from = beforeVals.get(path) ?? [];
    const to = afterVals.get(path) ?? [];
    for (let i = 0; i < Math.max(from.length, to.length); i++) {
      if (from[i] === to[i]) continue;
      changes.push({
        recordId: id,
        field: path,
        from: from[i] ? show(from[i]) : "",
        to: to[i] ? show(to[i]) : "",
        action: "incoming",
      });
    }
  }
  return changes;
}

/**
 * Whether a record marked changed in fact leaves the file exactly as it was, so
 * the save report should pass over it. Two ways that happens, both from an edit
 * later undoing an earlier one within the session:
 *
 *  - it was created and then removed again (connecting a second parent moves the
 *    child into the couple's existing family and drops the stub the first parent
 *    made) — it never reached the file and is not there now; or
 *  - it exists but is identical to the baseline snapshot taken when it first
 *    went dirty (that stub's other parent, whose pointer to it was added and
 *    then taken away) — nothing of it is written differently.
 *
 * The dirty flag stays put either way: it only decides whether Save is offered,
 * and offering it once too often is harmless, while the report must describe
 * what the file will actually receive.
 */
function contributesNothing(raw: GedNode | undefined, isNew: boolean, snapshot: GedNode | undefined): boolean {
  if (!raw) return isNew;
  return snapshot !== undefined && nodesEqual(raw, snapshot);
}

export function buildEditReport(
  changedPersonIds: Set<string>,
  changedFamilyIds: Set<string>,
  dataset: Dataset,
  loadedPersonIds: Set<string>,
  loadedFamilyIds: Set<string>,
  personSnapshots?: Map<string, GedNode>,
  familySnapshots?: Map<string, GedNode>,
  /** Top-level shared records (SOUR/OBJE/NOTE) edited on their own, with their
   *  pre-edit snapshots — no person or family carries these changes. */
  changedRecordIds?: Set<string>,
  recordSnapshots?: Map<string, { value: GedNode }>,
): ChangeReport {
  const changes: FieldChange[] = [];
  const recordLabels: Record<string, string> = {};
  const recordKinds: Record<string, "individual" | "family" | "record"> = {};
  const familySpouses: Record<string, FamilySpouseInfo[]> = {};
  let newPersons = 0;
  let newFamilies = 0;

  for (const id of changedPersonIds) {
    const indi = dataset.individuals.get(id);
    const isNew = !loadedPersonIds.has(id);
    if (contributesNothing(indi?.raw, isNew, personSnapshots?.get(id))) continue;
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
    if (contributesNothing(fam?.raw, isNew, famSnap)) continue;
    const isRemoved = !fam && !isNew;
    recordLabels[id] = entries.map((e) => e.name).join(" + ") || id;
    recordKinds[id] = "family";
    if (entries.length) familySpouses[id] = entries;
    changes.push({ recordId: id, field: "", from: "", to: "", action: "incoming", newRecord: isNew, removedRecord: isRemoved });
    if (isNew) newFamilies++;
  }

  const labelFor = makeXrefLabeler(dataset.records);
  for (const id of changedRecordIds ?? []) {
    const current = dataset.records.find((r) => r.xref === id);
    const snapshot = recordSnapshots?.get(id)?.value;
    recordLabels[id] = sharedRecordLabel(id, current ?? snapshot);
    recordKinds[id] = "record";
    // No snapshot means no pre-edit state was ever captured: the record was
    // created this session (snapshots are taken from every patch's `before`),
    // so it shows as New rather than Changed.
    const isNew = !!current && !snapshot;
    changes.push({ recordId: id, field: "", from: "", to: "", action: "incoming", newRecord: isNew, removedRecord: !current });
    // A record created this session has no snapshot to diff against, and
    // without this its card would carry a title and nothing else — the whole
    // point of adding a source is the title and the link it brought with it.
    if (current) changes.push(...diffSharedRecordNodes(id, snapshot ?? emptyLike(current), current, labelFor));
  }

  return {
    changes,
    deferred: [],
    graftJoins: [],
    recordsChanged: new Set(changes.map((c) => c.recordId)).size,
    newPersons,
    newFamilies,
    recordLabels,
    recordKinds,
    familySpouses,
    customTags: {},
  };
}

export function combineReports(a: ChangeReport, b: ChangeReport): ChangeReport {
  const changes = [...a.changes, ...b.changes];
  const recordIds = new Set(changes.map((c) => c.recordId));
  return {
    changes,
    deferred: [...a.deferred, ...b.deferred],
    graftJoins: [...a.graftJoins, ...b.graftJoins],
    recordsChanged: recordIds.size,
    newPersons: a.newPersons + b.newPersons,
    newFamilies: a.newFamilies + b.newFamilies,
    recordLabels: { ...a.recordLabels, ...b.recordLabels },
    recordKinds: { ...a.recordKinds, ...b.recordKinds },
    familySpouses: { ...a.familySpouses, ...b.familySpouses },
    customTags: { ...a.customTags, ...b.customTags },
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
