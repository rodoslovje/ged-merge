import type { Dataset, GedEvent, Individual } from "../gedcom/types";
import { ALL_EVENT_TAGS, LDS_ORDINANCE_TAGS } from "../gedcom/eventTags";
import { computeKinship } from "../tools/batch";
import { defaultPrivacyOptions, livingReason } from "../tools/privacy";
import { isDeceased } from "../gedcom/lifespan";
import { runSteps, type Steps } from "../gedcom/steps";
import { reducedName, type LivingNameMode, type NameOrder } from "../gedcom/nameDisplay";
import { marriedSurnamesOf } from "../match/relatives";
import { unionMarriage } from "../gedcom/union";
import { planSitePhotos, type PhotoUse, type PubPhoto, type PubPhotoLink } from "./photos";
import { detectAddress } from "../tools/addresses";
import { cleanNoteHtml, isHtmlNote, noteToText } from "../gedcom/noteHtml";
import { isWebAddress, withScheme } from "../gedcom/uri";
import type { GeoCoord, NoteRef, SourceCitation } from "../gedcom/types";
import type { MapOverlay } from "../ui/SettingsContext";

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
export type LivingMode = "hide" | LivingNameMode | "all";
export const LIVING_MODES: LivingMode[] = ["hide", "anonymous", "initials", "given", "name", "all"];

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

/** The site's map: the base map, and the extra layers its readers may switch
 *  on — the author's own (Settings → Map), as many of them as they choose. */
export interface SiteMap {
  /** A base-map preset id (`ui/map/basemapPresets.ts`); "" is the default. */
  basemap: string;
  /** The tile URL of a custom base map. */
  tileUrl: string;
  overlays: MapOverlay[];
}

export interface PublishOptions {
  title: string;
  /** A few words from the author, shown on the site's front page — one text
   *  per language, by language code; the site shows the reader's. */
  intro: Record<string, string>;
  scope: ScopeKind;
  /** With `blood` / `line`: also publish the partners of the people in scope,
   *  so their families read whole. */
  partners: boolean;
  living: LivingMode;
  /** People who died within this many years are published as the living are
   *  (0 = off). Slovenia's data protection act (ZVOP-2) asks for 20. */
  recentDeathYears: number;
  startPage: StartPage;
  /** Let visitors download charts, reports and statistics (SVG, PDF, CSV…). */
  exports: boolean;
  /** Where the site will be hosted (`https://tree.example.org`): named in the
   *  footer of its exports in place of gedmerge.com. Empty for none. */
  url: string;
  /** The website's own address, where its page is — for a shared link's
   *  preview, when `url` is the author's site that links to it. "" for `url`. */
  siteUrl: string;
  /** Search engines may index the website (and follow its links). Off: the
   *  page asks them to leave it out. */
  indexable: boolean;
  /** The website's icon: an image's address. "" for the website address's own
   *  `favicon.ico`, else GED Merge's (see `viewer/favicon.ts`). */
  favicon: string;
  display: SiteDisplay;
  /** What the site also shows beside names, dates and places. Without
   *  addresses a house's coordinate gives way to its settlement's. */
  include: SiteIncludes;
  /** Where each folder's photos go (see `photos.ts`); a folder not named
   *  follows the one above it, and by default all go in, strip too. */
  photoFolders: Record<string, PhotoUse>;
  /** The cover photo, a file of the media folder (its path there): on the
   *  front page and in a shared link's preview. "" for none. */
  cover: string;
  map: SiteMap;
  /** The site's language on first open. */
  lang: string;
}

/** An icon address as the page can use it: one with a scheme or a path as it
 *  is, one that starts with a host name (`example.org/icon.png`) over https. */
export function iconAddress(value: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || /^[./]/.test(value)) return value;
  return /^[^/\s]+\.[a-z]{2,}\//i.test(value) ? `https://${value}` : value;
}

export function defaultPublishOptions(
  title: string,
  lang: string,
  display: SiteDisplay = DEFAULT_SITE_DISPLAY,
  map: SiteMap = { basemap: "", tileUrl: "", overlays: [] },
): PublishOptions {
  return {
    title,
    intro: {},
    scope: "all",
    partners: true,
    living: "initials",
    recentDeathYears: 20,
    startPage: "home",
    exports: false,
    url: "",
    siteUrl: "",
    indexable: false,
    favicon: "",
    display,
    include: { sources: false, notes: false, addresses: false, photos: false },
    photoFolders: {},
    cover: "",
    map,
    lang,
  };
}

export interface SiteIncludes {
  sources: boolean;
  notes: boolean;
  addresses: boolean;
  /** Photos: the website is then a ZIP, the page and its photos (see
   *  `photos.ts` for which photos may go in). */
  photos: boolean;
}
export const SITE_INCLUDES: (keyof SiteIncludes)[] = ["photos", "sources", "addresses", "notes"];

/** A source citation as the site shows it: the source, the cited page, a link. */
export interface PubSource {
  title?: string;
  page?: string;
  url?: string;
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
  /** The street address, with addresses published. */
  address?: string;
  notes?: string[];
  /** Each note's clean HTML where it was written with formatting, by its
   *  place in `notes`; absent when none was. */
  notesRich?: (string | null)[];
  sources?: PubSource[];
}

export interface PubPerson {
  id: string;
  given?: string;
  surname?: string;
  sex?: "M" | "F" | "X";
  /** Married surnames, for the "married surname" name display. */
  married?: string[];
  /** Their photos, in their order (see `photos.ts`). */
  photos?: PubPhotoLink[];
  /** Living, published without their details (see {@link LivingMode}). */
  living?: true;
  /** Among those, dead within the protected years (see `recentDeathYears`):
   *  shown as dead, without a date. */
  deceased?: true;
  events?: PubEvent[];
  notes?: string[];
  /** See {@link PubEvent.notesRich}. */
  notesRich?: (string | null)[];
  sources?: PubSource[];
}

export interface PubFamily {
  id: string;
  husband?: string;
  wife?: string;
  children?: string[];
  events?: PubEvent[];
  notes?: string[];
  /** See {@link PubEvent.notesRich}. */
  notesRich?: (string | null)[];
  sources?: PubSource[];
  /** Married, with the marriage's details withheld (a living or private spouse). */
  married?: true;
}

export interface PublishedTree {
  format: typeof PUBLISHED_FORMAT;
  version: typeof PUBLISHED_VERSION;
  title: string;
  /** The author's words, by language code. */
  intro?: Record<string, string>;
  /** Sources were published (the site then shows them). */
  sources?: true;
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
  /** The map's base and layers. */
  map?: SiteMap;
  /** The photos the people's pages show (see `photos.ts`). */
  photos?: PubPhoto[];
  /** The cover photo's id among `photos`: the front page's picture and a
   *  shared link's preview image. */
  cover?: string;
  /** Where the page itself is, when not at `url` (see PublishOptions). */
  siteUrl?: string;
  /** Search engines may index it (see PublishOptions). */
  indexable?: true;
  /** The icon's address, when the author named one. */
  favicon?: string;
  /** The cover made small for a link preview (see `previewImage.ts`), in the
   *  ZIP beside its photos. */
  preview?: { path: string; width: number; height: number };
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
  /** Photos published, and photos left out because someone hidden is on them
   *  (or they are private) — with photos chosen. */
  photos: number;
  photosWithheld: number;
}

/** Events a site shows: every life event the app knows, minus the LDS
 *  ordinances (church records of their own, not life events) and any event
 *  the file flags private on its own. */
function publishable(e: GedEvent): boolean {
  return !e.private && ALL_EVENT_TAGS.has(e.tag) && !LDS_ORDINANCE_TAGS.has(e.tag);
}

/** What converting the records needs besides each record: the options, and the
 *  settlement coordinates a house gives way to (see {@link settlementCoords}). */
interface Ctx {
  include: SiteIncludes;
  settlements: Map<string, GeoCoord>;
}

/** A coordinate rounded to two decimals, about a kilometre: where a house's
 *  settlement has no coordinate of its own, this is all the site says. */
const roughly = (c: GeoCoord): GeoCoord => ({ lat: Math.round(c.lat * 100) / 100, lon: Math.round(c.lon * 100) / 100 });

/**
 * The coordinate each place value has where no address goes with it — the
 * settlement's, as opposed to a house's (the app writes a house's coordinate on
 * its own event's PLAC.MAP, see `tools/addresses.ts`). The most frequent wins.
 */
function settlementCoords(ds: Dataset): Map<string, GeoCoord> {
  const tally = new Map<string, Map<string, { coord: GeoCoord; n: number }>>();
  const visit = (events: GedEvent[]) => {
    for (const e of events) {
      const raw = e.place?.raw.trim();
      const coord = e.place?.coord;
      if (!raw || !coord || detectAddress(raw, e.address?.raw.trim() ?? "").address) continue;
      let byCoord = tally.get(raw);
      if (!byCoord) tally.set(raw, (byCoord = new Map()));
      const key = `${coord.lat}:${coord.lon}`;
      const hit = byCoord.get(key);
      if (hit) hit.n++;
      else byCoord.set(key, { coord, n: 1 });
    }
  };
  for (const indi of ds.individuals.values()) visit(indi.events);
  for (const fam of ds.families.values()) visit(fam.events);
  const out = new Map<string, GeoCoord>();
  for (const [place, byCoord] of tally) out.set(place, [...byCoord.values()].sort((a, b) => b.n - a.n)[0].coord);
  return out;
}

type PubNotes = { notes?: string[]; notesRich?: (string | null)[] };

/** The notes to publish — never a private one — each as its text, and as its
 *  clean HTML beside it where it was written with formatting. */
function pubNotes(refs: NoteRef[] | undefined): PubNotes {
  const notes: string[] = [];
  const rich: (string | null)[] = [];
  for (const ref of refs ?? []) {
    if (ref.private) continue;
    const text = noteToText(ref.text).trim();
    if (!text) continue;
    notes.push(text);
    rich.push(isHtmlNote(ref.text) ? cleanNoteHtml(ref.text) : null);
  }
  if (!notes.length) return {};
  return rich.some(Boolean) ? { notes, notesRich: rich } : { notes };
}

/**
 * A source's link as the published page may carry it: an address the web can
 * open, on http(s). The value comes from the file — a citation's page link, a
 * repository's `WWW` — and the page is opened by people who never saw that
 * file, so anything else (a local path, a `javascript:` line) is left out
 * rather than handed to them as a link.
 */
export function publishedUrl(url: string | undefined): string | undefined {
  const value = url?.trim();
  if (!value || !isWebAddress(value)) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) return undefined;
  return withScheme(value);
}

function pubSources(cites: SourceCitation[] | undefined): PubSource[] | undefined {
  const out: PubSource[] = [];
  for (const c of cites ?? []) {
    const s: PubSource = {};
    if (c.title?.trim()) s.title = c.title.trim();
    if (c.page?.trim()) s.page = c.page.trim();
    const url = publishedUrl(c.url);
    if (url) s.url = url;
    if (s.title || s.page || s.url) out.push(s);
  }
  return out.length ? out : undefined;
}

function pubEvent(e: GedEvent, ctx: Ctx): PubEvent {
  const out: PubEvent = { tag: e.tag };
  if (e.type) out.type = e.type;
  if (e.value?.trim()) out.value = e.value.trim();
  if (e.date?.raw.trim()) out.date = e.date.raw.trim();
  const raw = e.place?.raw.trim();
  const addr = e.address?.raw.trim() ?? "";
  let coord = e.place?.coord;
  if (ctx.include.addresses) {
    if (raw) out.place = raw;
    if (addr) out.address = addr;
  } else if (raw) {
    // No addresses: an event at a house is shown at its settlement — the
    // place without the house number, at the settlement's coordinate.
    const at = detectAddress(raw, addr);
    if (at.address) {
      if (at.place) out.place = at.place;
      const settlement = ctx.settlements.get(at.place);
      coord = settlement ?? (coord && roughly(coord));
    } else {
      out.place = raw;
    }
  }
  if (out.place && coord) {
    out.lat = coord.lat;
    out.lon = coord.lon;
  }
  if (e.cause?.trim()) out.cause = e.cause.trim();
  if (ctx.include.notes) {
    Object.assign(out, pubNotes(e.noteRefs));
  }
  if (ctx.include.sources) {
    const sources = pubSources(e.sources);
    if (sources) out.sources = sources;
  }
  return out;
}

function pubEvents(events: GedEvent[], ctx: Ctx): PubEvent[] | undefined {
  const out = events
    .filter(publishable)
    .map((e) => pubEvent(e, ctx))
    .filter((e) => e.date || e.place || e.value || e.type || e.cause || e.address || e.notes || e.sources || e.tag !== "EVEN");
  return out.length ? out : undefined;
}

/** A record's own notes and sources, as the options allow. */
function recordExtras(rec: { noteRefs?: NoteRef[]; sources?: SourceCitation[] }, ctx: Ctx): PubNotes & { sources?: PubSource[] } {
  const out: PubNotes & { sources?: PubSource[] } = ctx.include.notes ? pubNotes(rec.noteRefs) : {};
  const sources = ctx.include.sources ? pubSources(rec.sources) : undefined;
  if (sources) out.sources = sources;
  return out;
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

/** Everyone the scope publishes, or null for the whole file. A narrowed scope
 *  whose person is gone publishes nobody — never quietly everyone. */
function scopeIds(ds: Dataset, opts: PublishOptions, startId: string | undefined): Set<string> | null {
  if (opts.scope === "all") return null;
  const kin = startId ? computeKinship(ds, startId) : null;
  if (!startId || !kin) return new Set();
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
  /** The photos to put in the website's ZIP: its path there, and the `FILE`
   *  of the author's media folder it is read from. */
  files: { path: string; source: string }[];
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
  const ctx: Ctx = { include: opts.include, settlements: opts.include.addresses ? new Map() : settlementCoords(ds) };
  // The dead of the last `recentDeathYears` count as living too (Slovenia's
  // ZVOP-2 asks for 20 years), as the Privacy tool counts them.
  const privacy = { ...defaultPrivacyOptions(), alsoRecentlyDeceasedYears: opts.recentDeathYears };
  const year = now.getFullYear();
  const privateIds = new Set<string>();
  const living = new Set<string>();
  const checked = new Set<string>();
  for (const indi of ds.individuals.values()) {
    if (tick()) yield;
    checked.add(indi.id);
    const why = livingReason(indi, ds, privacy, year)?.reason;
    if (why) (why === "declared" ? privateIds : living).add(indi.id);
  }

  const summary: PublishSummary = { people: 0, families: 0, livingReduced: 0, livingHidden: 0, privateHidden: 0, photos: 0, photosWithheld: 0 };
  const byXref = new Map<string, PubPerson>();
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
    // A person the first pass never saw (added while the steps were paused)
    // has had no living check: they count as living.
    const isLiving = living.has(indi.id) || !checked.has(indi.id);
    if (isLiving && opts.living === "hide") {
      summary.livingHidden++;
      continue;
    }
    const id = hashId("p", indi.uids?.[0] ?? indi.id, taken);
    idOf.set(indi.id, id);
    const person = pubPerson(indi, id, isLiving ? opts.living : "all", isLiving, ctx);
    people.push(person);
    byXref.set(indi.id, person);
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
    // details, unless their details are published in full. A private spouse's
    // never goes.
    const spouses = [fam.husband, fam.wife].filter((s): s is string => !!s);
    const open = !spouses.some((s) => privateIds.has(s)) && (opts.living === "all" || !spouses.some((s) => living.has(s) || !checked.has(s)));
    const events = open ? pubEvents(fam.events, ctx) : undefined;
    if (events) out.events = events;
    if (open) Object.assign(out, recordExtras(fam, ctx));
    // That they married is kept, without when or where, so the couple is
    // still named spouses rather than partners (see `match/kinship.ts`).
    else if (unionMarriage(fam) === "married") out.married = true;
    families.push(out);
  }

  // Photos: none with anyone hidden on them, and only on the pages of people
  // published with their details.
  const files: PublishResult["files"] = [];
  let photos: PubPhoto[] = [];
  let cover: string | undefined;
  if (opts.include.photos) {
    const withheld = (id: string) => opts.living !== "all" && (living.has(id) || !checked.has(id));
    const plan = yield* planSitePhotos(
      ds,
      (id) => byXref.has(id) && !withheld(id),
      (id) => privateIds.has(id) || withheld(id),
      opts.photoFolders,
      opts.cover,
    );
    photos = plan.photos;
    cover = plan.cover;
    for (const [xref, links] of plan.links) byXref.get(xref)!.photos = links;
    for (const [path, source] of plan.sources) files.push({ path, source });
    summary.photos = plan.photos.length;
    summary.photosWithheld = plan.withheld;
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
  const intro = Object.fromEntries(Object.entries(opts.intro).map(([l, s]) => [l, s.trim()]).filter(([, s]) => s));
  if (Object.keys(intro).length) tree.intro = intro;
  if (opts.include.sources) tree.sources = true;
  if (opts.exports) tree.exports = true;
  if (opts.url.trim()) tree.url = opts.url.trim();
  if (opts.siteUrl.trim()) tree.siteUrl = opts.siteUrl.trim();
  if (opts.indexable) tree.indexable = true;
  if (opts.favicon.trim()) tree.favicon = iconAddress(opts.favicon.trim());
  tree.display = opts.display;
  tree.map = opts.map;
  const start = startId ? idOf.get(startId) : undefined;
  if (start) tree.start = start;
  // The person's pages need the person; without one the site opens at home.
  if (opts.startPage === "stats" || (opts.startPage !== "home" && start)) tree.startPage = opts.startPage;
  progress?.(total, total);
  if (photos.length) tree.photos = photos;
  if (cover) tree.cover = cover;
  return { tree, summary, files };
}

function pubPerson(indi: Individual, id: string, mode: LivingMode, isLiving: boolean, ctx: Ctx): PubPerson {
  const name = indi.names[0];
  const out: PubPerson = { id };
  if (mode === "anonymous") {
    // No name at all: the site calls them "Living" (or "Deceased") itself.
  } else if (mode === "initials" || mode === "given") {
    // Cut down as the charts' privacy setting cuts it (see reducedName).
    const reduced = reducedName(name, mode);
    if (reduced?.given) out.given = reduced.given;
    if (reduced?.surname) out.surname = reduced.surname;
  } else {
    const given = name?.given?.trim() ?? (name?.surname ? undefined : name?.full.replace(/\//g, "").trim());
    if (given) out.given = given;
    if (name?.surname?.trim()) out.surname = name.surname.trim();
    const married = marriedSurnamesOf(indi);
    if (married.length) out.married = married;
  }
  if (indi.sex === "M" || indi.sex === "F" || indi.sex === "X") out.sex = indi.sex;
  if (isLiving && mode !== "all") {
    out.living = true;
    // Dead within the protected years: published as the living are, but known
    // to be dead — the charts draw them so, without a date.
    if (isDeceased(indi)) out.deceased = true;
  }
  if (mode === "all") {
    const events = pubEvents(indi.events, ctx);
    if (events) out.events = events;
    Object.assign(out, recordExtras(indi, ctx));
  }
  return out;
}
