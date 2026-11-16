import type { Dataset, GedEvent, Individual } from "../gedcom/types";
import { ALL_EVENT_TAGS, LDS_ORDINANCE_TAGS } from "../gedcom/eventTags";
import { computeKinship } from "../tools/batch";
import { defaultPrivacyOptions, livingReason } from "../tools/privacy";
import { runSteps, type Steps } from "../gedcom/steps";
import type { NameOrder } from "../gedcom/nameDisplay";
import { marriedSurnamesOf } from "../match/relatives";

/**
 * The family website's data: what a relative browsing the published page can
 * see, and nothing more.
 *
 * It is a display model, not a GEDCOM: names, sex, the life events with their
 * date and place as text, and who is whose parent, spouse and child. Everything
 * a researcher would need to lift the work wholesale stays behind — sources and
 * citations, notes, media, addresses and contact details, record ids and sync
 * ids (`_UID`, FamilySearch), change stamps, vendor extras. Ids are opaque and
 * stable across exports (a hash of the record's id), so a link to a person on
 * the site keeps working when the site is published again.
 *
 * Privacy is decided here, once: people flagged private never leave, and living
 * people are left out or reduced as the exporter chose.
 */

/** Format marker + version of {@link PublishedTree}, read by the viewer. */
export const PUBLISHED_FORMAT = "gedmerge-site";
export const PUBLISHED_VERSION = 1;

/** What a living person keeps on the site: nothing, initials, the given name
 *  alone (which says next to nothing on its own — the youngest generations
 *  carry no surname either), the full name, or everything. */
export type LivingMode = "hide" | "initials" | "given" | "name" | "all";
export const LIVING_MODES: LivingMode[] = ["hide", "initials", "given", "name", "all"];

/** Who is published: everyone, the start person's blood relatives, or their
 *  direct line (ancestors and descendants). */
export type ScopeKind = "all" | "blood" | "line";
export const SCOPE_KINDS: ScopeKind[] = ["all", "blood", "line"];

/** The page a visitor lands on: the front page, the start person, their
 *  charts, or the statistics. */
export type StartPage = "home" | "person" | "charts" | "stats";
export const START_PAGES: StartPage[] = ["home", "person", "charts", "stats"];

/** How the site shows people — the app's own display settings (Settings →
 *  Names and Display), chosen for the site by its author. */
export interface SiteDisplay {
  order: NameOrder;
  uppercaseSurname: boolean;
  marriedSurname: boolean;
  /** A date display choice (see `ui/dateDisplayFormat.ts`); "" is the file's text. */
  dateDisplay: string;
  showAge: boolean;
  showKinship: boolean;
  emphasizeDirect: boolean;
}

export const DEFAULT_SITE_DISPLAY: SiteDisplay = {
  order: "given-surname",
  uppercaseSurname: false,
  marriedSurname: false,
  dateDisplay: "words",
  showAge: false,
  showKinship: true,
  emphasizeDirect: true,
};

export interface PublishOptions {
  title: string;
  /** A few words from the author, shown on the site's front page. */
  intro: string;
  scope: ScopeKind;
  /** With `blood` / `line`: also publish the partners of the people in scope,
   *  so their families read whole. */
  partners: boolean;
  living: LivingMode;
  startPage: StartPage;
  /** Let visitors download charts, reports and statistics (SVG, PDF, CSV…). */
  exports: boolean;
  /** Where the site will be hosted (`https://tree.example.org`): named in the
   *  footer of its exports in place of gedmerge.com. Empty for none. */
  url: string;
  display: SiteDisplay;
  /** The site's language on first open. */
  lang: string;
}

export function defaultPublishOptions(title: string, lang: string, display: SiteDisplay = DEFAULT_SITE_DISPLAY): PublishOptions {
  return { title, intro: "", scope: "all", partners: true, living: "initials", startPage: "home", exports: false, url: "", display, lang };
}

export interface PubEvent {
  tag: string;
  /** The event's `TYPE` (a custom event's name). */
  type?: string;
  /** The value on the event line (an occupation, a residence…). */
  value?: string;
  /** The date as the file writes it. */
  date?: string;
  place?: string;
  lat?: number;
  lon?: number;
  /** Cause of death. */
  cause?: string;
}

export interface PubPerson {
  id: string;
  given?: string;
  surname?: string;
  sex?: "M" | "F" | "X";
  /** Married surnames, for the "married surname" name display. */
  married?: string[];
  /** Living, published without their details (see {@link LivingMode}). */
  living?: true;
  events?: PubEvent[];
}

export interface PubFamily {
  id: string;
  husband?: string;
  wife?: string;
  children?: string[];
  events?: PubEvent[];
}

export interface PublishedTree {
  format: typeof PUBLISHED_FORMAT;
  version: typeof PUBLISHED_VERSION;
  title: string;
  intro?: string;
  /** Export date, yyyy-mm-dd. */
  created: string;
  lang: string;
  /** The start person: where the charts open, and the person page offered first. */
  start?: string;
  /** The page a visitor lands on; absent is the front page. */
  startPage?: StartPage;
  /** Downloads are offered on the site. */
  exports?: true;
  /** The site's own address, for the footer of its exports. */
  url?: string;
  /** How people are shown. */
  display?: SiteDisplay;
  people: PubPerson[];
  families: PubFamily[];
}

export interface PublishSummary {
  people: number;
  families: number;
  /** Living people published reduced, and living people left out. */
  livingReduced: number;
  livingHidden: number;
  /** People flagged private, never published. */
  privateHidden: number;
}

/** Event tags a site shows: every life event the app knows, minus the LDS
 *  ordinances (church records of their own, not life events). */
function publishable(e: GedEvent): boolean {
  return ALL_EVENT_TAGS.has(e.tag) && !LDS_ORDINANCE_TAGS.has(e.tag);
}

function pubEvent(e: GedEvent): PubEvent {
  const out: PubEvent = { tag: e.tag };
  if (e.type) out.type = e.type;
  if (e.value?.trim()) out.value = e.value.trim();
  if (e.date?.raw.trim()) out.date = e.date.raw.trim();
  if (e.place?.raw.trim()) {
    out.place = e.place.raw.trim();
    if (e.place.coord) {
      out.lat = e.place.coord.lat;
      out.lon = e.place.coord.lon;
    }
  }
  if (e.cause?.trim()) out.cause = e.cause.trim();
  return out;
}

function pubEvents(events: GedEvent[]): PubEvent[] | undefined {
  const out = events.filter(publishable).map(pubEvent).filter((e) => e.date || e.place || e.value || e.type || e.cause || e.tag !== "EVEN");
  return out.length ? out : undefined;
}

/** A short, stable, opaque id: FNV-1a of the key, in base 36. */
function hashId(prefix: string, key: string, taken: Set<string>): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const base = prefix + (h >>> 0).toString(36);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}${n}`;
  taken.add(id);
  return id;
}

const initial = (s: string | undefined): string | undefined => {
  const c = s?.trim()[0];
  return c ? `${c.toUpperCase()}.` : undefined;
};

/** Everyone the scope publishes, or null for the whole file. */
function scopeIds(ds: Dataset, opts: PublishOptions, startId: string | undefined): Set<string> | null {
  if (opts.scope === "all" || !startId) return null;
  const kin = computeKinship(ds, startId);
  if (!kin) return null;
  const ids = opts.scope === "blood" ? new Set(kin.blood) : new Set([startId, ...kin.ancestors, ...kin.descendants]);
  if (opts.partners) {
    for (const id of [...ids]) {
      for (const famId of ds.individuals.get(id)?.spouseOf ?? []) {
        const fam = ds.families.get(famId);
        if (fam?.husband) ids.add(fam.husband);
        if (fam?.wife) ids.add(fam.wife);
      }
    }
  }
  return ids;
}

/** Records handled between two yields of {@link buildPublishedTreeSteps}. */
const RECORDS_PER_STEP = 1_000;

export interface PublishResult {
  tree: PublishedTree;
  summary: PublishSummary;
}

/** Build the site's data from the main file. `now` pins "living" in tests. */
export function buildPublishedTree(
  ds: Dataset,
  opts: PublishOptions,
  startId: string | undefined,
  now: Date = new Date(),
): PublishResult {
  return runSteps(buildPublishedTreeSteps(ds, opts, startId, now));
}

/** {@link buildPublishedTree} as a stepped pass (see `steps.ts`): it yields
 *  every {@link RECORDS_PER_STEP} records, after telling `progress` how many
 *  of the file's people and families it has been through. */
export function* buildPublishedTreeSteps(
  ds: Dataset,
  opts: PublishOptions,
  startId: string | undefined,
  now: Date = new Date(),
  progress?: (done: number, total: number) => void,
): Steps<PublishResult> {
  // People are walked twice — who is living, then what is published — and
  // families once; the living check is the slow half, so it counts too.
  const total = 2 * ds.individuals.size + ds.families.size;
  let done = 0;
  /** Count one record; true when it is time to yield. */
  const tick = () => {
    if (++done % RECORDS_PER_STEP !== 0) return false;
    progress?.(done, total);
    return true;
  };
  const inScope = scopeIds(ds, opts, startId);
  const privacy = defaultPrivacyOptions();
  const year = now.getFullYear();
  const privateIds = new Set<string>();
  const living = new Set<string>();
  for (const indi of ds.individuals.values()) {
    if (tick()) yield;
    const why = livingReason(indi, ds, privacy, year)?.reason;
    if (why) (why === "declared" ? privateIds : living).add(indi.id);
  }

  const summary: PublishSummary = { people: 0, families: 0, livingReduced: 0, livingHidden: 0, privateHidden: 0 };
  const taken = new Set<string>();
  const idOf = new Map<string, string>();
  const people: PubPerson[] = [];
  for (const indi of ds.individuals.values()) {
    if (tick()) yield;
    if (inScope && !inScope.has(indi.id)) continue;
    if (privateIds.has(indi.id)) {
      summary.privateHidden++;
      continue;
    }
    const isLiving = living.has(indi.id);
    if (isLiving && opts.living === "hide") {
      summary.livingHidden++;
      continue;
    }
    const id = hashId("p", indi.uids?.[0] ?? indi.id, taken);
    idOf.set(indi.id, id);
    people.push(pubPerson(indi, id, isLiving ? opts.living : "all", isLiving));
    if (isLiving && opts.living !== "all") summary.livingReduced++;
  }

  const families: PubFamily[] = [];
  for (const fam of ds.families.values()) {
    if (tick()) yield;
    if (fam.private) continue;
    const husband = fam.husband ? idOf.get(fam.husband) : undefined;
    const wife = fam.wife ? idOf.get(fam.wife) : undefined;
    const children = fam.children.map((c) => idOf.get(c)).filter((c): c is string => !!c);
    // A family is published when it still links two people: a couple, or a
    // parent and a child.
    if ((husband ? 1 : 0) + (wife ? 1 : 0) + children.length < 2) continue;
    const out: PubFamily = { id: hashId("f", fam.id, taken) };
    if (husband) out.husband = husband;
    if (wife) out.wife = wife;
    if (children.length) out.children = children;
    // A living spouse's marriage is their own life too: it goes with their
    // details, unless their details are published in full.
    const spouseLiving = [fam.husband, fam.wife].some((s) => s && living.has(s));
    const events = opts.living === "all" || !spouseLiving ? pubEvents(fam.events) : undefined;
    if (events) out.events = events;
    families.push(out);
  }

  summary.people = people.length;
  summary.families = families.length;
  const tree: PublishedTree = {
    format: PUBLISHED_FORMAT,
    version: PUBLISHED_VERSION,
    title: opts.title.trim(),
    created: now.toISOString().slice(0, 10),
    lang: opts.lang,
    people,
    families,
  };
  if (opts.intro.trim()) tree.intro = opts.intro.trim();
  if (opts.exports) tree.exports = true;
  if (opts.url.trim()) tree.url = opts.url.trim();
  tree.display = opts.display;
  const start = startId ? idOf.get(startId) : undefined;
  if (start) tree.start = start;
  // The person's pages need the person; without one the site opens at home.
  if (opts.startPage === "stats" || (opts.startPage !== "home" && start)) tree.startPage = opts.startPage;
  progress?.(total, total);
  return { tree, summary };
}

function pubPerson(indi: Individual, id: string, mode: LivingMode, isLiving: boolean): PubPerson {
  const name = indi.names[0];
  const out: PubPerson = { id };
  if (mode === "initials") {
    const g = initial(name?.given);
    const s = initial(name?.surname);
    if (g) out.given = g;
    if (s) out.surname = s;
  } else {
    const given = name?.given?.trim() ?? (name?.surname ? undefined : name?.full.replace(/\//g, "").trim());
    if (given) out.given = given;
    if (mode !== "given" && name?.surname?.trim()) out.surname = name.surname.trim();
    const married = mode === "given" ? [] : marriedSurnamesOf(indi);
    if (married.length) out.married = married;
  }
  if (indi.sex === "M" || indi.sex === "F" || indi.sex === "X") out.sex = indi.sex;
  if (isLiving && mode !== "all") out.living = true;
  if (mode === "all") {
    const events = pubEvents(indi.events);
    if (events) out.events = events;
  }
  return out;
}
