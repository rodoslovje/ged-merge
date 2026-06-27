import type { Dataset, GedNode, GedcomVersion, Individual } from "../gedcom/types";
import { cloneNode } from "../gedcom/node";
import { birthYear, deathYear, isDeceased, lifespanOf } from "../gedcom/lifespan";

/**
 * Privacy / anonymization for living people.
 *
 * Genealogy files routinely contain detailed data about living relatives that
 * you don't want to publish. This tool flags likely-living individuals and
 * produces a redacted copy of the GEDCOM for sharing — the live master is never
 * touched (same download-only contract as Normalize and the source de-duper).
 *
 * "Living" is inferred, not declared: a person with no death/burial/cremation
 * event who is estimated to be young enough to still be alive. The estimate
 * comes from their own birth year, or — when that's missing — from dated
 * relatives, or finally a configurable assume-living fallback.
 *
 * Everything here is a pure function over the lossless `GedNode` forest so the
 * redaction round-trips cleanly and can be unit-tested without a DOM.
 */

export type PrivacyAction = "sanitize" | "remove" | "removeDescendants";
export type NameStrategy = "living" | "private" | "initials" | "initialSurname" | "surnameOnly";
export type ResnMode = "stripStamp" | "stripOnly" | "markOnly";

/** Which detail categories the sanitizer can strip from a flagged record. */
export type StripCategory = "events" | "notes" | "sources" | "media" | "contact";

/** Why an individual was flagged as living — surfaced in the preview breakdown. */
export type LivingReason = "birth" | "relative" | "unknown" | "recentDeath";

export interface PrivacyOptions {
  /** Treat an undated, un-dead person as living if their (estimated) birth is
   *  fewer than this many years ago. */
  livingThresholdYears: number;
  /** Also privatize people who died within this many years (0 = off). */
  alsoRecentlyDeceasedYears: number;
  /** What to do with a living person whose birth can't be dated even via relatives. */
  unknownBirthPolicy: "living" | "skip";
  action: PrivacyAction;
  nameStrategy: NameStrategy;
  /** Replacement text for the "private" name strategy (any user-chosen label). */
  customName: string;
  strip: Record<StripCategory, boolean>;
  resn: ResnMode;
  file: {
    /** Drop the SUBM (submitter) record — your own name/address/email. */
    stripSubmitter: boolean;
    /** Drop external sync ids (_UID/_FID/AFN/RIN) that can re-link a tree. */
    stripExternalIds: boolean;
    /** Remove postal addresses (ADDR/RESI) from every record, not just living people. */
    scrubAddress: boolean;
    /** Remove email addresses (EMAIL/EMAI) from every record. */
    scrubEmail: boolean;
    /** Remove phone/fax numbers (PHON/FAX) from every record. */
    scrubPhone: boolean;
  };
}

export interface FlaggedPerson {
  id: string;
  /** Name + lifespan, for the preview list. */
  subject: string;
  reason: LivingReason;
}

export interface PrivacyReport {
  /** Every individual the heuristic flagged as living (the preview list). */
  flagged: FlaggedPerson[];
  byReason: Record<LivingReason, number>;
  /** Individuals whose details were stripped in place. */
  sanitized: number;
  /** INDI records removed entirely (includes cascaded descendants). */
  removed: number;
  /** Family records whose event details were stripped / RESN-stamped. */
  familiesPrivatized: number;
  /** Family records dropped because removal left them empty. */
  familiesRemoved: number;
  submitterRemoved: boolean;
  externalIdsStripped: number;
  contactScrubbed: number;
}

export function defaultPrivacyOptions(): PrivacyOptions {
  return {
    livingThresholdYears: 100,
    alsoRecentlyDeceasedYears: 0,
    unknownBirthPolicy: "living",
    action: "sanitize",
    nameStrategy: "living",
    customName: "Private",
    strip: { events: true, notes: true, sources: true, media: true, contact: true },
    resn: "stripStamp",
    file: { stripSubmitter: false, stripExternalIds: false, scrubAddress: false, scrubEmail: false, scrubPhone: false },
  };
}

// Individual children that carry the tree's shape — always kept on a sanitized
// record so navigation survives — plus audit stamps, which are harmless.
const INDI_STRUCTURE = new Set(["SEX", "FAMC", "FAMS", "CHAN", "CREA"]);
// Family children that carry the tree's shape.
const FAM_STRUCTURE = new Set(["HUSB", "WIFE", "CHIL", "CHAN", "CREA"]);
const FAM_POINTERS = new Set(["HUSB", "WIFE", "CHIL"]);
const CONTACT_TAGS = new Set(["ADDR", "EMAIL", "EMAI", "PHON", "FAX", "WWW", "RESI"]);
// File-level scrub buckets (a subset split of CONTACT_TAGS the user can target
// individually); WWW is intentionally left out of the global scrub.
const ADDRESS_TAGS = new Set(["ADDR", "RESI"]);
const EMAIL_TAGS = new Set(["EMAIL", "EMAI"]);
const PHONE_TAGS = new Set(["PHON", "FAX"]);
const EXTERNAL_ID_TAGS = new Set(["_UID", "_FID", "AFN", "RIN"]);

/** A rough generational gap (years) used to estimate an undated birth from kin. */
const GENERATION = 28;

/** The detail bucket a non-structural child falls into, for the strip toggles. */
function detailCategory(tag: string): StripCategory {
  if (CONTACT_TAGS.has(tag)) return "contact";
  if (tag === "NOTE") return "notes";
  if (tag === "SOUR") return "sources";
  if (tag === "OBJE") return "media";
  return "events"; // BIRT/DEAT/OCCU/EVEN/REFN/_UID/ASSO/… — everything else
}

// ── Living detection ─────────────────────────────────────────────────────────

/** Estimate a birth year from dated immediate relatives, biased toward the most
 *  recent evidence (so borderline people lean "living" — the safe default). */
function estimateBirthYear(indi: Individual, ds: Dataset): number | undefined {
  let est: number | undefined;
  const consider = (y: number | undefined, delta: number) => {
    if (y === undefined) return;
    const v = y + delta;
    if (est === undefined || v > est) est = v;
  };
  // Parents → this person was born ~a generation later.
  for (const famId of indi.childOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    consider(birthYear(fam.husband ? ds.individuals.get(fam.husband) : undefined), GENERATION);
    consider(birthYear(fam.wife ? ds.individuals.get(fam.wife) : undefined), GENERATION);
  }
  // Spouse (same generation) and children (~a generation earlier).
  for (const famId of indi.spouseOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    const otherId = fam.husband === indi.id ? fam.wife : fam.husband;
    consider(birthYear(otherId ? ds.individuals.get(otherId) : undefined), 0);
    for (const cid of fam.children) consider(birthYear(ds.individuals.get(cid)), -GENERATION);
  }
  return est;
}

/** Why this individual counts as living, or undefined when presumed deceased. */
function livingReason(
  indi: Individual,
  ds: Dataset,
  opts: PrivacyOptions,
  currentYear: number,
): LivingReason | undefined {
  if (isDeceased(indi)) {
    const dy = deathYear(indi);
    if (opts.alsoRecentlyDeceasedYears > 0 && dy !== undefined && currentYear - dy <= opts.alsoRecentlyDeceasedYears) {
      return "recentDeath";
    }
    return undefined;
  }
  const by = birthYear(indi);
  if (by !== undefined) return currentYear - by < opts.livingThresholdYears ? "birth" : undefined;
  const est = estimateBirthYear(indi, ds);
  if (est !== undefined) return currentYear - est < opts.livingThresholdYears ? "relative" : undefined;
  return opts.unknownBirthPolicy === "living" ? "unknown" : undefined;
}

/** A short label for the preview list: primary name + life years. */
function subjectOf(indi: Individual): string {
  const name = indi.names[0]?.full?.trim() || indi.id;
  const span = lifespanOf(indi);
  return span ? `${name} (${span})` : name;
}

/** All individuals the heuristic flags as living, with the reason for each. */
export function findLiving(
  ds: Dataset,
  opts: PrivacyOptions,
  currentYear: number = new Date().getFullYear(),
): FlaggedPerson[] {
  const out: FlaggedPerson[] = [];
  for (const indi of ds.individuals.values()) {
    const reason = livingReason(indi, ds, opts, currentYear);
    if (reason) out.push({ id: indi.id, subject: subjectOf(indi), reason });
  }
  out.sort((a, b) => a.subject.localeCompare(b.subject));
  return out;
}

// ── Node builders ────────────────────────────────────────────────────────────

const initial = (s: string | undefined): string => {
  const c = s?.trim()[0];
  return c ? c.toUpperCase() : "";
};

/** The redacted NAME value for a person under the chosen strategy. */
function sanitizedNameValue(indi: Individual, strategy: NameStrategy, customName: string): string {
  const name = indi.names[0];
  const given = name?.given;
  const surname = name?.surname;
  switch (strategy) {
    case "living":
      return "Living";
    case "private":
      return customName.trim() || "Private";
    case "surnameOnly":
      return surname ? `/${surname}/` : "Private";
    case "initials": {
      const parts = [initial(given), initial(surname)].filter(Boolean);
      return parts.length ? parts.map((p) => `${p}.`).join("") : "Private";
    }
    case "initialSurname": {
      const gi = initial(given);
      if (surname) return gi ? `${gi}. /${surname}/` : `/${surname}/`;
      return gi ? `${gi}.` : "Private";
    }
  }
}

function nameNode(indi: Individual, strategy: NameStrategy, customName: string): GedNode {
  return { level: 1, tag: "NAME", value: sanitizedNameValue(indi, strategy, customName), children: [] };
}

function resnNode(version: GedcomVersion): GedNode {
  // 7.0 enumerations are upper-case; 5.5.1 uses lower-case restriction values.
  return { level: 1, tag: "RESN", value: version === "7.0" ? "PRIVACY" : "privacy", children: [] };
}

/** Add a RESN privacy notice unless the record already carries one. */
function stampResn(node: GedNode, version: GedcomVersion): GedNode {
  if (node.children.some((c) => c.tag === "RESN")) return node;
  return { ...node, children: [resnNode(version), ...node.children] };
}

// ── Record transforms ────────────────────────────────────────────────────────

/** Strip a flagged individual down to a redacted name + structural links. A
 *  RESN notice, if wanted, is added by the caller via {@link stampResn}. */
function sanitizeIndi(rec: GedNode, indi: Individual, opts: PrivacyOptions): GedNode {
  const body: GedNode[] = [];
  for (const child of rec.children) {
    if (child.tag === "NAME" || child.tag === "RESN") continue; // replaced / re-added
    if (INDI_STRUCTURE.has(child.tag)) {
      body.push(cloneNode(child));
      continue;
    }
    if (opts.strip[detailCategory(child.tag)]) continue;
    body.push(cloneNode(child));
  }
  return { level: 0, xref: rec.xref, tag: "INDI", children: [nameNode(indi, opts.nameStrategy, opts.customName), ...body] };
}

/** Strip event/detail children from a family that includes a living spouse. */
function sanitizeFamily(rec: GedNode, opts: PrivacyOptions): GedNode {
  const kept: GedNode[] = [];
  for (const child of rec.children) {
    if (child.tag === "RESN") continue;
    if (FAM_STRUCTURE.has(child.tag)) {
      kept.push(cloneNode(child));
      continue;
    }
    if (opts.strip[detailCategory(child.tag)]) continue;
    kept.push(cloneNode(child));
  }
  return { ...cloneNode(rec), children: kept };
}

/** Drop HUSB/WIFE/CHIL pointers that reference a removed individual. */
function scrubFamilyPointers(rec: GedNode, removed: Set<string>): GedNode {
  const children = rec.children.filter(
    (c) => !(FAM_POINTERS.has(c.tag) && c.value && removed.has(c.value)),
  );
  return { ...rec, children };
}

/** A family with no spouses and no children is a husk — drop it. */
function familyIsEmpty(rec: GedNode): boolean {
  return !rec.children.some((c) => FAM_POINTERS.has(c.tag));
}

/** Recursively remove external-id / contact children, counting removals. */
function scrubGeneric(node: GedNode, opts: PrivacyOptions, counts: { ids: number; contact: number }): GedNode {
  const children: GedNode[] = [];
  for (const child of node.children) {
    if (opts.file.stripExternalIds && EXTERNAL_ID_TAGS.has(child.tag)) {
      counts.ids++;
      continue;
    }
    if (
      (opts.file.scrubAddress && ADDRESS_TAGS.has(child.tag)) ||
      (opts.file.scrubEmail && EMAIL_TAGS.has(child.tag)) ||
      (opts.file.scrubPhone && PHONE_TAGS.has(child.tag))
    ) {
      counts.contact++;
      continue;
    }
    children.push(scrubGeneric(child, opts, counts));
  }
  return { ...node, children };
}

/** Collect an individual and all their descendants (children, grandchildren…). */
function collectDescendants(id: string, ds: Dataset, into: Set<string>): void {
  const indi = ds.individuals.get(id);
  if (!indi) return;
  for (const famId of indi.spouseOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    for (const childId of fam.children) {
      if (into.has(childId)) continue;
      into.add(childId);
      collectDescendants(childId, ds, into);
    }
  }
}

/**
 * Produce a redacted copy of `ds.records` per `options`. The live dataset is not
 * mutated; the returned records are ready to serialize and download.
 */
export function privatizeDataset(
  ds: Dataset,
  options: PrivacyOptions,
  currentYear: number = new Date().getFullYear(),
): { records: GedNode[]; report: PrivacyReport } {
  const flaggedList = findLiving(ds, options, currentYear);
  const flagged = new Set(flaggedList.map((f) => f.id));

  const stripData = options.resn !== "markOnly";
  const addResn = options.resn === "stripStamp" || options.resn === "markOnly";
  const removing = stripData && (options.action === "remove" || options.action === "removeDescendants");

  // The set of INDI records to delete outright (plus cascaded descendants).
  const removeSet = new Set<string>();
  if (removing) {
    for (const id of flagged) removeSet.add(id);
    if (options.action === "removeDescendants") {
      for (const id of [...flagged]) collectDescendants(id, ds, removeSet);
    }
  }

  const byReason: Record<LivingReason, number> = { birth: 0, relative: 0, unknown: 0, recentDeath: 0 };
  for (const f of flaggedList) byReason[f.reason]++;

  const report: PrivacyReport = {
    flagged: flaggedList,
    byReason,
    sanitized: 0,
    removed: 0,
    familiesPrivatized: 0,
    familiesRemoved: 0,
    submitterRemoved: false,
    externalIdsStripped: 0,
    contactScrubbed: 0,
  };

  // Phase 1 — flag / remove transform on top-level records.
  const interim: GedNode[] = [];
  for (const rec of ds.records) {
    if (rec.tag === "SUBM" && rec.xref && options.file.stripSubmitter) {
      report.submitterRemoved = true;
      continue;
    }
    if (rec.tag === "HEAD" && options.file.stripSubmitter) {
      interim.push({ ...cloneNode(rec), children: cloneNode(rec).children.filter((c) => c.tag !== "SUBM") });
      continue;
    }

    if (rec.tag === "INDI" && rec.xref) {
      if (removeSet.has(rec.xref)) {
        report.removed++;
        continue;
      }
      const indi = ds.individuals.get(rec.xref);
      const isFlagged = indi && flagged.has(rec.xref);
      if (isFlagged && stripData) {
        const node = sanitizeIndi(rec, indi, options);
        interim.push(addResn ? stampResn(node, ds.version) : node);
        report.sanitized++;
      } else if (isFlagged && addResn) {
        interim.push(stampResn(cloneNode(rec), ds.version)); // markOnly: keep data, label it
      } else {
        interim.push(cloneNode(rec));
      }
      continue;
    }

    if (rec.tag === "FAM" && rec.xref) {
      const fam = ds.families.get(rec.xref);
      const spouseFlagged = !!fam && ((!!fam.husband && flagged.has(fam.husband)) || (!!fam.wife && flagged.has(fam.wife)));
      let node = cloneNode(rec);
      if (removeSet.size) node = scrubFamilyPointers(node, removeSet);
      if (familyIsEmpty(node)) {
        report.familiesRemoved++;
        continue;
      }
      if (spouseFlagged && stripData) {
        node = sanitizeFamily(node, options);
        if (addResn) node = stampResn(node, ds.version);
        report.familiesPrivatized++;
      } else if (spouseFlagged && addResn) {
        node = stampResn(node, ds.version);
        report.familiesPrivatized++;
      }
      interim.push(node);
      continue;
    }

    interim.push(cloneNode(rec));
  }

  // Phase 2 — file-level scrubs across every surviving record.
  const counts = { ids: 0, contact: 0 };
  const needsScrub =
    options.file.stripExternalIds || options.file.scrubAddress || options.file.scrubEmail || options.file.scrubPhone;
  const records = needsScrub ? interim.map((rec) => scrubGeneric(rec, options, counts)) : interim;
  report.externalIdsStripped = counts.ids;
  report.contactScrubbed = counts.contact;

  return { records, report };
}
