import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, Individual } from "../../gedcom/types";
import { reducedName } from "../../gedcom/nameDisplay";
import { buildCalendar, byDay, factKey, type CalendarOptions, type CalendarScope, type Fact, type MemorialMode } from "../../calendar/model";
import { HOLIDAY_COUNTRIES, holidaysFor, type HolidayCountry } from "../../calendar/holidays";
import { LIVING_NAMES, nameAndKinship, factDate, factSentence, monthName, yearsAgo, type LivingNames, type PersonWords } from "../../calendar/text";
import { createKinshipResolver } from "../../match/kinship";
import { primaryName } from "../../match/relatives";
import { isDeceased, isPresumedLiving, lifespanOf } from "../../gedcom/lifespan";
import { ChartPage } from "../ChartPage";
import { ChartRootTitle } from "../ChartRootTitle";
import { StartPersonSelector } from "../StartPersonSelector";
import { sexClass } from "../sex";
import { useNameOf } from "../SettingsContext";
import { useChartSettings } from "../ChartSettingsContext";
import { useMediaFolder } from "../MediaFolderContext";
import { collectFirstFilePath } from "../PersonMedia";
import { isPointer, looksLikeUrl, objeInfoOf, objeNodesFor } from "../../gedcom/source";
import { mediaKindOf } from "../mediaPath";
import { useBloodTrees } from "../useBloodTrees";
import { useFanChart } from "../useFanChart";
import { FanChartBody } from "../FanChartBody";
import { TreeSvg } from "../TreeSvg";
import { flatten, layout, nodeHeight } from "../../chart/treeLayout";
import type { TreeNode } from "../../chart/personTree";
import { ANCESTOR_KEY_PREFIX } from "../../chart/treeLayout";
import { buildSiblingRow } from "../../chart/siblingRow";
import { embedImages, escapeHtml, prepareDiagram, printDocument, siteLinkOf } from "../exportSvg";
import { storedSiteAddress } from "../../publish/stored";
import { clearSavedCalendars, readSavedCalendar, writeSavedCalendar } from "../../calendar/stored";
import { useSettingsSlice } from "../SettingsContext";
import { PrinterIcon } from "../icons/FormatIcons";
import { CALENDAR_CSS, calendarPrintCss } from "./calendarCss";
import { CALENDAR_SCHEMES, PALETTES, type CalendarScheme } from "./schemes";
import { CALENDAR_FORMATS, CoverPage, MonthPages, PAPER, type CalendarFormat, type PagePhoto } from "./CalendarPage";
import { PhotoArea } from "./PhotoArea";
import { StatsCard } from "./StatsCard";
import { BackPage, WhoIsWho, YearOverview } from "./BackPage";
import { familyStats } from "../../calendar/stats";
import type { FanChart } from "../../chart/fanLayout";
import { Segmented } from "../Segmented";
import { SelectMenu } from "../DropdownMenu";
import { afterPaint } from "../busyCursor";
import { COLLAGE_STYLES, MAX_PHOTOS, type CollageStyle } from "../../calendar/collage";

// The Charts hub's "Calendar" kind: a family calendar to give as a present,
// seen from the hub's root person (the one who gets it). A wizard — settings,
// then the cover, then each month with its picture and its moments from the
// family's past picked from a few suggestions, then a last look and print.
// Not on the family website: it shows the birthdays of the living.

interface Props {
  mainDs: Dataset;
  /** The main file's name, for the family website's address in the footer. */
  mainFileName?: string;
  rootId: string;
  backLabel: string;
  onBack: () => void;
  onRootChange: (id: string) => void;
  kindSwitcher?: React.ReactNode;
}

const SCOPES: CalendarScope[] = ["descendants", 0, 1, 2, 3];
const MEMORIALS: MemorialMode[] = ["off", "lifetime", 1, 2];
/** How many people's photos a page offers. */
const PHOTO_CHOICES = 8;
/** How many people a group photo's own caption names before it stops. */
const GROUP_NAMES = 4;
/** Generations each way on the cover's fan. */
const FAN_GENERATIONS = 4;
/** Steps: settings, cover, twelve months, review. */
const MONTH_STEP0 = 2;
const BACK_STEP = MONTH_STEP0 + 12;
const REVIEW_STEP = BACK_STEP + 1;
/** The calendar's charts hang on a wall: the living show by the names choice only — no
 *  years or age — and no couple's wedding year is written. */
const FAN_DISPLAY_OFF = {
  showKinship: false, showPhoto: false, privacyLiving: true, showMarriageDate: false, showMarriagePlace: false,
} as const;

/** A tree's largest scale on the page: a 220-px box at most 12 em wide. */
const TREE_EM_PER_PX = 12 / 220;

/** A tree laid out for a page: descendants top-down, ancestors left to right. */
function laidTree(tree: TreeNode | undefined, ancestors: boolean, nodeH: number) {
  if (!tree) return undefined;
  const alignment = ancestors ? "lr" : "tb";
  const laid = layout(tree, alignment, nodeH);
  return { ...laid, flat: flatten(laid.root, alignment, "curve", nodeH, undefined, ancestors) };
}

type CountryChoice = HolidayCountry | "none";

const PERSIST_KEYS = ["persistWorkspace"] as const;

/** Everything the reader chooses in the wizard. */
interface CalendarWork {
  format: CalendarFormat;
  scheme: CalendarScheme;
  livingNames: LivingNames;
  showAge: boolean;
  captions: boolean;
  large: boolean;
  showList: boolean;
  showFacts: boolean;
  country: CountryChoice;
  opts: CalendarOptions;
  cover: Picture;
  dedication: string;
  back: Back;
  /** The givers' own line in the back page's colophon. */
  signature: string;
  /** Per month: the picture chosen, or undefined for the month's default. */
  monthPictures: (Picture | undefined | null)[];
  /** Per month: the facts picked (by {@link factKey}), or undefined for the default. */
  monthFacts: (string[] | undefined | null)[];
}

function defaultWork(lang: string, thisYear: number): CalendarWork {
  return {
    format: "wallTop",
    scheme: "gedmerge",
    livingNames: "initial",
    showAge: true,
    captions: true,
    large: false,
    showList: true,
    showFacts: true,
    country: lang === "hr" ? "hr" : lang === "sl" ? "si" : "none",
    // From September on, the calendar is for the year to come.
    opts: { year: new Date().getMonth() >= 8 ? thisYear + 1 : thisYear, scope: 1, partners: true, memorial: "off" },
    cover: { kind: "fan" },
    dedication: "",
    back: { kind: "overview" },
    signature: "",
    monthPictures: [],
    monthFacts: [],
  };
}

/** A picture as it can be kept: one's own files left out (their addresses
 *  last only for this visit). */
function keptPicture(pic: Picture | undefined | null): Picture | null {
  if (!pic) return null;
  return pic.kind === "photos" ? { ...pic, items: pic.items.filter((it) => it.kind === "person") } : pic;
}

function keptWork(w: CalendarWork): Record<string, unknown> {
  return { ...w, cover: keptPicture(w.cover), monthPictures: w.monthPictures.map(keptPicture) };
}

/** A kept picture, when it still reads as one. */
function readPicture(v: unknown): Picture | undefined {
  if (!v || typeof v !== "object") return undefined;
  const p = v as { kind?: unknown; items?: unknown; collage?: unknown };
  if (!PICTURE_KINDS.includes(p.kind as Picture["kind"])) return undefined;
  if (p.kind !== "photos") return { kind: p.kind as Exclude<Picture["kind"], "photos"> };
  const items = Array.isArray(p.items)
    ? p.items.filter((it): it is PhotoItem => !!it && typeof it === "object" && (it as PhotoItem).kind === "person" && typeof (it as { id?: unknown }).id === "string")
    : [];
  const collage = COLLAGE_STYLES.includes(p.collage as CollageStyle) ? (p.collage as CollageStyle) : "scattered";
  return { kind: "photos", items, collage };
}

/** `saved` laid over `base`, field by field: anything of the wrong kind (an
 *  older version, a hand edit) keeps the base's value. */
function mergeWork(base: CalendarWork, saved: Record<string, unknown>): CalendarWork {
  const pick = <K extends keyof CalendarWork>(k: K, ok: (v: unknown) => boolean): CalendarWork[K] =>
    (ok(saved[k]) ? saved[k] : base[k]) as CalendarWork[K];
  const one = (list: readonly unknown[]) => (v: unknown) => list.includes(v);
  const bool = (v: unknown) => typeof v === "boolean";
  const o = saved.opts && typeof saved.opts === "object" ? (saved.opts as Record<string, unknown>) : {};
  return {
    format: pick("format", one(CALENDAR_FORMATS)),
    scheme: pick("scheme", one(CALENDAR_SCHEMES)),
    livingNames: pick("livingNames", one(LIVING_NAMES)),
    showAge: pick("showAge", bool),
    captions: pick("captions", bool),
    large: pick("large", bool),
    showList: pick("showList", bool),
    showFacts: pick("showFacts", bool),
    country: pick("country", one(["none", ...HOLIDAY_COUNTRIES])),
    opts: {
      year: typeof o.year === "number" ? o.year : base.opts.year,
      scope: SCOPES.includes(o.scope as CalendarScope) ? (o.scope as CalendarScope) : base.opts.scope,
      partners: typeof o.partners === "boolean" ? o.partners : base.opts.partners,
      memorial: MEMORIALS.includes(o.memorial as MemorialMode) ? (o.memorial as MemorialMode) : base.opts.memorial,
    },
    cover: readPicture(saved.cover) ?? base.cover,
    dedication: typeof saved.dedication === "string" ? saved.dedication : "",
    back: saved.back && typeof saved.back === "object" && BACK_KINDS.includes((saved.back as Back).kind)
      ? { kind: (saved.back as Back).kind } as Back
      : base.back,
    signature: typeof saved.signature === "string" ? saved.signature : "",
    monthPictures: Array.isArray(saved.monthPictures) ? saved.monthPictures.slice(0, 12).map(readPicture) : [],
    monthFacts: Array.isArray(saved.monthFacts)
      ? saved.monthFacts.slice(0, 12).map((v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined))
      : [],
  };
}
type PhotoItem = { kind: "person"; id: string } | { kind: "file"; url: string; name: string };
/** What fills a page's picture area: photos (one, or a collage), or a chart. */
type Picture =
  | { kind: "photos"; items: PhotoItem[]; collage: CollageStyle }
  | { kind: "fan" | "fanAnc" | "fanDesc" | "treeDesc" | "treeAnc" | "stats" };
/** What the back page shows: the year at a glance, who is who, nothing, or a
 *  chart or the numbers, as a month's picture can. */
type Back = { kind: "overview" } | { kind: "gallery" } | { kind: "none" } | Exclude<Picture, { kind: "photos" }>;
const BACK_KINDS: Back["kind"][] = ["overview", "gallery", "fan", "fanAnc", "fanDesc", "treeDesc", "treeAnc", "stats", "none"];
/** A back-page choice's name: its own for the year, the gallery and none,
 *  the picture's for a chart or the numbers. */
function backKindLabel(t: (key: string) => string, kind: Back["kind"]): string {
  return kind === "overview" || kind === "gallery" || kind === "none" ? t(`calendar.back.${kind}`) : t(`calendar.picture.${kind}`);
}
const PICTURE_KINDS: Picture["kind"][] = ["photos", "fan", "fanAnc", "fanDesc", "treeDesc", "treeAnc", "stats"];

const sameItem = (a: PhotoItem, b: PhotoItem) =>
  a.kind === "person" ? b.kind === "person" && a.id === b.id : b.kind === "file" && a.url === b.url;

export function CalendarView({ mainDs, mainFileName, rootId, backLabel, onBack, onRootChange, kindSwitcher }: Props) {
  const { t, i18n } = useTranslation();
  const nameOf = useNameOf();
  const thisYear = new Date().getFullYear();
  const [step, setStep] = useState(0);

  // The whole work in one state: kept per file and recipient while the
  // workspace is kept in the browser, and restored when either comes back.
  const { persistWorkspace } = useSettingsSlice(PERSIST_KEYS);
  const defaults = useMemo(() => defaultWork(i18n.language, thisYear), [i18n.language, thisYear]);
  const restore = useCallback(
    (base: CalendarWork) => {
      const saved = persistWorkspace && mainFileName ? readSavedCalendar(mainFileName, rootId) : undefined;
      // A recipient with nothing kept keeps the settings, not the choices.
      return saved
        ? mergeWork(base, saved)
        : { ...base, cover: defaults.cover, dedication: "", back: defaults.back, signature: "", monthPictures: [], monthFacts: [] };
    },
    [persistWorkspace, mainFileName, rootId, defaults],
  );
  const [work, setWork] = useState<CalendarWork>(() => restore(defaults));
  const workKey = `${mainFileName ?? ""} ${rootId}`;
  const [loadedKey, setLoadedKey] = useState(workKey);
  useEffect(() => {
    if (loadedKey === workKey) return;
    setWork((w) => restore(w));
    setLoadedKey(workKey);
  }, [workKey, loadedKey, restore]);
  // Saved only once the state is the one loaded for this key, so a switch of
  // recipient never writes the last one's work under the new one's name.
  useEffect(() => {
    if (!persistWorkspace) { clearSavedCalendars(); return; }
    if (mainFileName && loadedKey === workKey) writeSavedCalendar(mainFileName, rootId, keptWork(work));
  }, [work, persistWorkspace, mainFileName, rootId, loadedKey, workKey]);

  const { format, scheme, livingNames, showAge, captions, large, country, opts, cover, dedication, monthPictures, monthFacts } = work;
  const patch = (p: Partial<CalendarWork>) => setWork((w) => ({ ...w, ...p }));
  const setFormat = (format: CalendarFormat) => patch({ format });
  const setScheme = (scheme: CalendarScheme) => patch({ scheme });
  const setLivingNames = (livingNames: LivingNames) => patch({ livingNames });
  const setShowAge = (showAge: boolean) => patch({ showAge });
  const setCaptions = (captions: boolean) => patch({ captions });
  const setLarge = (large: boolean) => patch({ large });
  const setShowList = (showList: boolean) => patch({ showList });
  const setShowFacts = (showFacts: boolean) => patch({ showFacts });
  const setCountry = (country: CountryChoice) => patch({ country });
  const setOpts = (opts: CalendarOptions) => patch({ opts });
  const setCover = (cover: Picture) => patch({ cover });
  const setDedication = (dedication: string) => patch({ dedication });
  const setBack = (back: Back) => patch({ back });
  const setSignature = (signature: string) => patch({ signature });
  const setMonthPictures = (f: (prev: CalendarWork["monthPictures"]) => CalendarWork["monthPictures"]) =>
    setWork((w) => ({ ...w, monthPictures: f(w.monthPictures) }));
  const setMonthFacts = (f: (prev: CalendarWork["monthFacts"]) => CalendarWork["monthFacts"]) =>
    setWork((w) => ({ ...w, monthFacts: f(w.monthFacts) }));
  const entryOpts = useMemo(() => ({ names: livingNames, age: showAge, large }), [livingNames, showAge, large]);

  const root = mainDs.individuals.get(rootId);
  // The family website's address, as set in Tools → Website for this file.
  const site = useMemo(() => {
    const address = mainFileName ? storedSiteAddress(mainFileName) : undefined;
    return address ? siteLinkOf(address).label : undefined;
  }, [mainFileName]);
  const data = useMemo(() => buildCalendar(mainDs, rootId, opts, thisYear), [mainDs, rootId, opts, thisYear]);
  const holidays = useMemo(() => (country === "none" ? [] : holidaysFor(country, opts.year)), [country, opts.year]);


  const kinship = useMemo(() => createKinshipResolver(mainDs, rootId, t), [mainDs, rootId, t]);
  // The living go by the names choice everywhere on the calendar — the day
  // cells, the lines, the captions and the charts; the dead by their full name.
  const livingNameOf = useCallback(
    (p: Individual | undefined): string | undefined => {
      if (!p) return undefined;
      const n = primaryName(p);
      if (livingNames === "full") return nameOf(p);
      if (livingNames === "initial") {
        const given = n?.given?.trim();
        const initial = n?.surname?.trim().charAt(0).toLocaleUpperCase();
        if (given) return nameOf({ full: initial ? `${given} ${initial}.` : given, given, surname: initial && `${initial}.` });
      }
      const reduced = reducedName(n, livingNames === "initials" ? "initials" : "given");
      return reduced ? nameOf(reduced) : undefined;
    },
    [livingNames, nameOf],
  );
  const words: PersonWords = useMemo(() => ({
    name: (id) => {
      const p = mainDs.individuals.get(id);
      if (!p) return id;
      return ((isPresumedLiving(p, mainDs) || p.private) && livingNameOf(p)) || nameOf(p);
    },
    given: (id) => {
      const p = mainDs.individuals.get(id);
      return primaryName(p!)?.given?.split(/\s+/)[0] || (p ? nameOf(p) : id);
    },
    surname: (id) => { const p = mainDs.individuals.get(id); return p ? primaryName(p)?.surname?.trim() || undefined : undefined; },
    kinship: (id) => (id === rootId ? undefined : kinship.label(id)),
    sex: (id) => mainDs.individuals.get(id)?.sex,
  }), [mainDs, nameOf, kinship, rootId, livingNameOf]);

  // Photos: each person's first image, resolved through the linked media folder.
  const media = useMediaFolder();
  // Who is on each photo file, and the photo's own title: a group photo is
  // captioned by its title (where the file usually says what it shows), or
  // else by the people on it. Each person's local images, in file order.
  const { photoIndex, imagesOf } = useMemo(() => {
    const objes = objeNodesFor(mainDs.records);
    const photoIndex = new Map<string, { ids: string[]; title?: string }>();
    const imagesOf = new Map<string, string[]>();
    for (const indi of mainDs.individuals.values()) {
      for (const link of indi.raw.children) {
        if (link.tag !== "OBJE") continue;
        const v = link.value?.trim();
        const node = v && isPointer(v) ? objes.get(v) : link;
        if (!node) continue;
        const file = node.children.find((c) => c.tag === "FILE")?.value?.trim();
        if (!file || looksLikeUrl(file) || mediaKindOf(file) !== "image") continue;
        const title = objeInfoOf(node).title;
        const entry = photoIndex.get(file) ?? { ids: [], title };
        if (!entry.ids.includes(indi.id)) entry.ids.push(indi.id);
        entry.title ??= title;
        photoIndex.set(file, entry);
        const own = imagesOf.get(indi.id) ?? [];
        if (!own.includes(file)) own.push(file);
        imagesOf.set(indi.id, own);
      }
    }
    return { photoIndex, imagesOf };
  }, [mainDs]);
  /** A person's portrait: their marked or first photo when they are alone on
   *  it, else the first photo of them alone — a group photo only when they
   *  have nothing else, so two people from one big group do not bring the
   *  same picture twice. */
  const photoPath = useCallback((id: string): string | null => {
    const p = mainDs.individuals.get(id);
    const primary = p ? collectFirstFilePath(p.raw, mainDs.records) : null;
    const files = [...(primary ? [primary] : []), ...(imagesOf.get(id) ?? [])];
    return files.find((f) => (photoIndex.get(f)?.ids.length ?? 1) === 1) ?? files[0] ?? null;
  }, [mainDs, imagesOf, photoIndex]);
  const [urls, setUrls] = useState<Map<string, string | null>>(new Map());
  const withPhoto = useCallback((ids: string[]) => {
    const out: string[] = [];
    for (const id of ids) if (!out.includes(id) && photoPath(id)) out.push(id);
    return out.slice(0, PHOTO_CHOICES);
  }, [photoPath]);
  const coverPeople = useMemo(() => withPhoto([rootId, ...data.people]), [withPhoto, rootId, data.people]);
  const monthPeople = useMemo(
    () => data.months.map((m) => withPhoto([...m.entries.flatMap((e) => e.ids), ...m.candidates.flatMap((f) => f.ids)])),
    [data.months, withPhoto],
  );
  useEffect(() => {
    if (!media.folderName) return;
    const wanted = new Set([...coverPeople, ...monthPeople.flat()].map(photoPath).filter((p): p is string => !!p));
    const missing = [...wanted].filter((p) => !urls.has(p));
    if (!missing.length) return;
    let live = true;
    void Promise.all(missing.map(async (p) => [p, await media.resolveFile(p)] as const)).then((got) => {
      if (live) setUrls((prev) => new Map([...prev, ...got]));
    });
    return () => { live = false; };
  }, [media, coverPeople, monthPeople, photoPath, urls]);

  const listFormat = useMemo(() => new Intl.ListFormat(i18n.language, { type: "conjunction" }), [i18n.language]);

  const personPhoto = useCallback((id: string): PagePhoto | undefined => {
    const path = photoPath(id);
    const url = path ? urls.get(path) : undefined;
    if (!url) return undefined;
    const group = photoIndex.get(path!);
    if (group && group.ids.length > 1) {
      // The person it was picked for first, then the others on it.
      const ids = [id, ...group.ids.filter((x) => x !== id)];
      const names = listFormat.format(ids.slice(0, GROUP_NAMES).map(words.name));
      return { url, caption: group.title || (ids.length > GROUP_NAMES ? `${names} …` : names) };
    }
    // The name and the kinship ("Tim Novak, great-grandson"), so whoever looks
    // at the page knows who is who; the years only for the dead.
    const p = mainDs.individuals.get(id);
    const years = isDeceased(p) ? lifespanOf(p) : "";
    return { url, caption: `${nameAndKinship(words, id)}${years ? ` (${years})` : ""}` };
  }, [photoPath, urls, mainDs, words, photoIndex, listFormat]);

  // The people whose birthday or wedding anniversary the month marks, with a photo.
  const monthCelebrated = useMemo(
    () => data.months.map((m) => withPhoto(m.entries.filter((e) => e.kind !== "memorial").flatMap((e) => e.ids)).slice(0, MAX_PHOTOS)),
    [data.months, withPhoto],
  );
  /** A month's picture until one is chosen: a collage of everyone it
   *  celebrates — so the page shows the faces behind its birthdays — or, with
   *  none of them pictured, its first suggested person. */
  const monthPicture = (i: number): Picture => {
    if (monthPictures[i]) return monthPictures[i];
    const celebrated = monthCelebrated[i].filter((id, k, all) => all.findIndex((x) => photoPath(x) === photoPath(id)) === k);
    const ids = celebrated.length ? celebrated : monthPeople[i].slice(0, 1);
    return { kind: "photos", items: ids.map((id) => ({ kind: "person", id })), collage: "scattered" };
  };

  const factsOf = useCallback((i: number): Fact[] => {
    const m = data.months[i];
    const picked = monthFacts[i];
    return picked ? m.candidates.filter((f) => picked.includes(factKey(f))).sort(byDay) : m.facts;
  }, [data.months, monthFacts]);

  // The cover's fan: the recipient's ancestors above, descendants below, and
  // their brothers and sisters at the sides.
  const trees = useBloodTrees(mainDs, rootId, FAN_GENERATIONS);
  const siblings = useMemo(() => (root ? buildSiblingRow(t, root, mainDs, nameOf) : undefined), [t, root, mainDs, nameOf]);
  const { settings } = useChartSettings();
  const fanDisplay = useMemo(() => ({ ...settings, ...FAN_DISPLAY_OFF }), [settings]);
  const noPhoto = useCallback(() => false, []);
  const { fan } = useFanChart(trees.ancestors, "circle", { mode: "both", other: trees.descendants, siblings, hasPhoto: noPhoto, display: fanDisplay, livingNameOf });
  const { fan: fanAnc } = useFanChart(trees.ancestors, "fan", { mode: "ancestors", hasPhoto: noPhoto, display: fanDisplay, livingNameOf });
  const { fan: fanDesc } = useFanChart(trees.descendants, "fan", { mode: "descendants", hasPhoto: noPhoto, display: fanDisplay, livingNameOf });
  const fanBody = (chart: FanChart | undefined, desc: (key: string, gen: number) => boolean) =>
    chart ? (
      <FanChartBody
        chart={chart}
        colorOf={(_n, seg) => (desc(seg.key, seg.gen) ? "var(--node-desc)" : "var(--node-main)")}
        selectedKey={null}
        onSelect={() => {}}
        mainRecords={mainDs.records}
        nativeTooltip={false}
      />
    ) : undefined;
  // The trees: descendants top-down, the root above them; ancestors as the
  // classic pedigree, the root on the left and each generation to its right.
  const treeNodeH = nodeHeight(fanDisplay);
  const treeDesc = useMemo(() => laidTree(trees.descendants, false, treeNodeH), [trees.descendants, treeNodeH]);
  const treeAnc = useMemo(() => laidTree(trees.ancestors, true, treeNodeH), [trees.ancestors, treeNodeH]);
  const treeBody = (t: ReturnType<typeof laidTree>, desc: boolean) =>
    t ? (
      // A small tree keeps its boxes at a reading size instead of blowing a
      // lone box up across the whole picture.
      <div className="cal-tree" style={{ maxWidth: `${t.width * TREE_EM_PER_PX}em`, maxHeight: `${t.height * TREE_EM_PER_PX}em` }}>
      <TreeSvg
        flat={t.flat}
        width={t.width}
        height={t.height}
        selectedKey={null}
        onSelect={() => {}}
        colorOf={(n) => (desc && n.key !== t.root.key ? "var(--node-desc)" : "var(--node-main)")}
        mainRecords={mainDs.records}
        display={fanDisplay}
        livingNameOf={livingNameOf}
        nodeH={treeNodeH}
        nativeTooltip={false}
      />
      </div>
    ) : undefined;
  const charts = {
    fan: fanBody(fan, (key, gen) => gen > 0 && !key.startsWith(ANCESTOR_KEY_PREFIX)),
    fanAnc: fanBody(fanAnc, () => false),
    fanDesc: fanBody(fanDesc, (_key, gen) => gen > 0),
    treeDesc: treeBody(treeDesc, true),
    treeAnc: treeBody(treeAnc, false),
  };
  const stats = useMemo(() => familyStats(mainDs, rootId, thisYear), [mainDs, rootId, thisYear]);

  const renderPicture = (pic: Picture): React.ReactNode => {
    if (pic.kind === "stats") return <StatsCard stats={stats} nameOf={words.name} sexOf={words.sex} />;
    if (pic.kind !== "photos") return <div className="cal-chart">{charts[pic.kind]}</div>;
    const photos = pic.items
      .map((it): PagePhoto | undefined => (it.kind === "file" ? { url: it.url } : personPhoto(it.id)))
      .filter((x): x is PagePhoto => !!x)
      .filter((x, i, all) => all.findIndex((y) => y.url === x.url) === i)
      .map((p) => (captions ? p : { url: p.url }));
    return <PhotoArea photos={photos} collage={pic.collage} />;
  };

  const coverPage = (
    <CoverPage format={format} scheme={scheme} year={opts.year} name={root ? nameOf(root) : ""} picture={renderPicture(cover)} site={site} dedication={dedication} />
  );
  // Who is who: everyone the calendar celebrates who has a portrait, in the
  // order of the year, one picture each.
  const galleryPeople = useMemo(() => {
    const ids: string[] = [];
    for (const m of data.months) for (const e of m.entries) if (e.kind !== "memorial") for (const id of e.ids) if (!ids.includes(id)) ids.push(id);
    const seen = new Set<string>();
    return ids
      .map((id) => personPhoto(id))
      .filter((p): p is PagePhoto => !!p && !seen.has(p.url) && !!seen.add(p.url));
  }, [data.months, personPhoto]);
  const made = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "long", year: "numeric" }).format(new Date()),
    [i18n.language],
  );
  const back = work.back;
  const backPage = back.kind === "none" ? null : (
    <BackPage
      format={format}
      scheme={scheme}
      title={back.kind === "overview" ? String(opts.year) : backKindLabel(t, back.kind)}
      signature={work.signature}
      made={made}
      site={site}
    >
      {back.kind === "overview" ? (
        <YearOverview months={data.months} words={words} entryOpts={entryOpts} />
      ) : back.kind === "gallery" ? (
        <WhoIsWho people={galleryPeople} />
      ) : (
        renderPicture(back)
      )}
    </BackPage>
  );

  const monthPage = (i: number) => (
    <MonthPages
      key={i}
      format={format}
      scheme={scheme}
      year={opts.year}
      month={data.months[i]}
      facts={factsOf(i)}
      holidays={holidays}
      picture={renderPicture(monthPicture(i))}
      site={site}
      words={words}
      entryOpts={entryOpts}
      showList={work.showList}
      showFacts={work.showFacts}
    />
  );

  const reviewRef = useRef<HTMLDivElement>(null);
  // Building the print document reads every photo and redraws every chart: the
  // button spins from the press until the print dialog is about to open.
  const [printing, setPrinting] = useState(false);
  const print = async () => {
    const el = reviewRef.current;
    if (!el || printing) return;
    setPrinting(true);
    try {
      await afterPaint();
      const doc = await printSource(el);
      await new Promise<void>((opened) => printDocument(doc, opened));
    } finally {
      setPrinting(false);
    }
  };
  const printSource = async (el: HTMLElement) => {
    // Photos point at object URLs, which mean nothing outside this page: each
    // goes into the print document as data, read once however often it is used.
    const images = new Map<string, string>();
    const pages = await Promise.all(Array.from(el.querySelectorAll<HTMLElement>(".cal-page")).map(async (page) => {
      const clone = page.cloneNode(true) as HTMLElement;
      // A chart is drawn with the app's stylesheet; the print document has
      // none, so each goes over as a standalone SVG with its styles baked in.
      const live = page.querySelectorAll<SVGSVGElement>(".cal-chart svg");
      const slots = clone.querySelectorAll(".cal-chart");
      for (let k = 0; k < live.length; k++) {
        if (slots[k]) slots[k].innerHTML = new XMLSerializer().serializeToString((await prepareDiagram(live[k])).clone);
      }
      await embedImages(clone, images);
      return clone.outerHTML;
    }));
    const title = `${t("calendar.cover.title")} ${opts.year}${root ? ` — ${nameOf(root)}` : ""}`;
    return (`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>${CALENDAR_CSS}${calendarPrintCss(PAPER[format])}</style></head><body><div class="cal-sheet">${pages.join("")}</div></body></html>`);
  };
  // The review draws every page at once: the spinner is painted before it does.
  const [opening, setOpening] = useState(false);
  const openReview = () => {
    setOpening(true);
    void afterPaint().then(() => {
      setStep(REVIEW_STEP);
      setOpening(false);
    });
  };

  const setMonthPicture = (i: number, pic: Picture) => setMonthPictures((prev) => { const next = [...prev]; next[i] = pic; return next; });
  const toggleFact = (i: number, k: number) => setMonthFacts((prev) => {
    const next = [...prev];
    const m = data.months[i];
    const cur = next[i] ?? m.facts.map(factKey);
    const key = factKey(m.candidates[k]);
    next[i] = cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key];
    return next;
  });

  const monthIndex = step - MONTH_STEP0;
  const stepLabel =
    step === 0 ? t("calendar.step.settings")
      : step === 1 ? t("calendar.step.cover")
        : step === REVIEW_STEP ? t("calendar.step.review")
          : step === BACK_STEP ? t("calendar.step.back")
          : `${monthName(i18n.language, monthIndex + 1)} (${monthIndex + 1}/12)`;

  let panel: React.ReactNode;
  let preview: React.ReactNode;
  if (step === 0) {
    panel = (
      <>
        <label className="cal-field">
          <span>{t("calendar.recipient")}</span>
          <StartPersonSelector
            individuals={mainDs.individuals}
            startId={rootId}
            onChange={onRootChange}
            icon="search"
            placeholder={t("calendar.recipient")}
            tooltip={t("calendar.recipient.tooltip")}
          />
        </label>
        <label className="cal-field">
          <span>{t("calendar.year")}</span>
          <SelectMenu
            value={String(opts.year)}
            onChange={(v) => setOpts({ ...opts, year: Number(v) })}
            options={[thisYear, thisYear + 1, thisYear + 2].map((y) => ({ value: String(y), label: String(y) }))}
          />
        </label>
        <label className="cal-field">
          <span>{t("calendar.format")}</span>
          <SelectMenu
            value={format}
            onChange={(v) => setFormat(v as CalendarFormat)}
            options={CALENDAR_FORMATS.map((f) => ({ value: f, label: t(`calendar.format.${f}`) }))}
          />
        </label>
        <div className="cal-field">
          <span>{t("calendar.scheme")}</span>
          <div className="cal-schemes" role="radiogroup" aria-label={t("calendar.scheme")}>
            {CALENDAR_SCHEMES.map((k) => {
              const p = PALETTES[k];
              return (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={scheme === k}
                  className={`nav-btn cal-scheme${scheme === k ? " active" : ""}`}
                  onClick={() => setScheme(k)}
                >
                  <span className="cal-swatches" aria-hidden="true">
                    {[p.accent, p.anniversary, p.holiday, p.tint].map((c, i) => <span key={i} style={{ background: c }} />)}
                  </span>
                  {t(`calendar.scheme.${k}`)}
                </button>
              );
            })}
          </div>
        </div>
        <label className="cal-field">
          <span>{t("calendar.scope")}</span>
          <SelectMenu
            value={String(opts.scope)}
            onChange={(v) => setOpts({ ...opts, scope: v === "descendants" ? "descendants" : (Number(v) as CalendarScope) })}
            options={SCOPES.map((s) => ({ value: String(s), label: t(`calendar.scope.${s}`) }))}
          />
        </label>
        <label className="cal-field">
          <span>{t("calendar.names")}</span>
          <SelectMenu
            value={livingNames}
            onChange={(v) => setLivingNames(v as LivingNames)}
            options={LIVING_NAMES.map((k) => ({ value: k, label: t(`calendar.names.${k}`) }))}
          />
        </label>
        <label className="cal-check">
          <input type="checkbox" checked={showAge} disabled={large} onChange={(e) => setShowAge(e.target.checked)} />
          <span>{t("calendar.showAge")}</span>
        </label>
        <label className="cal-check">
          <input type="checkbox" checked={large} onChange={(e) => setLarge(e.target.checked)} />
          <span>{t("calendar.large")}</span>
        </label>
        <label className="cal-check">
          <input type="checkbox" checked={work.showList} disabled={large} onChange={(e) => setShowList(e.target.checked)} />
          <span>{t("calendar.showList")}</span>
        </label>
        <label className="cal-check">
          <input type="checkbox" checked={work.showFacts} onChange={(e) => setShowFacts(e.target.checked)} />
          <span>{t("calendar.showFacts")}</span>
        </label>
        <label className="cal-check">
          <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} />
          <span>{t("calendar.captions")}</span>
        </label>
        <label className="cal-check">
          <input type="checkbox" checked={opts.partners} onChange={(e) => setOpts({ ...opts, partners: e.target.checked })} />
          <span>{t("calendar.partners")}</span>
        </label>
        <label className="cal-field">
          <span>{t("calendar.memorial")}</span>
          <SelectMenu
            value={String(opts.memorial)}
            onChange={(v) => setOpts({ ...opts, memorial: v === "off" || v === "lifetime" ? v : (Number(v) as MemorialMode) })}
            options={MEMORIALS.map((m) => ({ value: String(m), label: t(`calendar.memorial.${m}`) }))}
          />
        </label>
        <label className="cal-field">
          <span>{t("calendar.holidays")}</span>
          <SelectMenu
            value={country}
            onChange={(v) => setCountry(v as CountryChoice)}
            options={[
              { value: "none", label: t("calendar.holidays.none") },
              ...HOLIDAY_COUNTRIES.map((c) => ({ value: c, label: t(`calendar.holidays.${c}`) })),
            ]}
          />
        </label>
        <p className="settings-hint">{t("calendar.summary", { n: data.months.reduce((n, m) => n + m.entries.length, 0) })}</p>
      </>
    );
    preview = monthPage(new Date().getMonth());
  } else if (step === 1) {
    panel = (
      <>
        <label className="cal-field">
          <span>{t("calendar.dedication")}</span>
          <textarea
            className="settings-text-input"
            rows={2}
            value={dedication}
            placeholder={t("calendar.dedication.placeholder")}
            onChange={(e) => setDedication(e.target.value)}
          />
        </label>
        <PicturePicker people={coverPeople} value={cover} onChange={setCover} personPhoto={personPhoto} words={words} />
      </>
    );
    preview = coverPage;
  } else if (step === REVIEW_STEP) {
    panel = (
      <>
        <p className="settings-hint">{t("calendar.review.hint")}</p>
        <button type="button" className="nav-btn primary cal-print-btn" disabled={printing} aria-busy={printing} onClick={() => void print()}>
          {printing ? <span className="spinner" aria-hidden="true" /> : <PrinterIcon />} {t("calendar.print")}
        </button>
      </>
    );
    preview = (
      <div className="cal-review" ref={reviewRef}>
        <div className="cal-sheet">{coverPage}</div>
        {data.months.map((_, i) => <div key={i} className="cal-sheet cal-review-month">{monthPage(i)}</div>)}
        {backPage && <div className="cal-sheet">{backPage}</div>}
      </div>
    );
  } else if (step === BACK_STEP) {
    panel = (
      <>
        <label className="cal-field">
          <span>{t("calendar.back")}</span>
          <SelectMenu
            value={work.back.kind}
            onChange={(v) => setBack({ kind: v } as Back)}
            options={BACK_KINDS.map((k) => ({ value: k, label: backKindLabel(t, k) }))}
          />
        </label>
        {work.back.kind !== "none" && (
          <label className="cal-field">
            <span>{t("calendar.signature")}</span>
            <input
              className="settings-text-input"
              value={work.signature}
              placeholder={t("calendar.signature.placeholder")}
              onChange={(e) => setSignature(e.target.value)}
            />
          </label>
        )}
      </>
    );
    preview = backPage ?? <p className="settings-hint">{t("calendar.back.none")}</p>;
  } else {
    const m = data.months[monthIndex];
    const picked = monthFacts[monthIndex] ?? m.facts.map(factKey);
    panel = (
      <>
        <h3 className="cal-panel-head">{t("calendar.photo")}</h3>
        <PicturePicker
          people={monthPeople[monthIndex]}
          value={monthPicture(monthIndex)}
          onChange={(pic) => setMonthPicture(monthIndex, pic)}
          personPhoto={personPhoto}
          words={words}
        />
        <h3 className="cal-panel-head">{t("calendar.facts.title")}</h3>
        {m.candidates.length ? (
          <ul className="cal-fact-list">
            {m.candidates.map((f, k) => (
              <li key={k}>
                <label className="cal-check">
                  <input type="checkbox" checked={picked.includes(factKey(f))} onChange={() => toggleFact(monthIndex, k)} />
                  <span>
                    <span className="cal-fact-when-ui">{factDate(t, i18n.language, f.date)} · {yearsAgo(t, f.yearsAgo)}</span>
                    {" "}{factSentence(t, words, f)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="settings-hint">{t("calendar.facts.none")}</p>
        )}
      </>
    );
    preview = monthPage(monthIndex);
  }

  return (
    <ChartPage
      backLabel={backLabel}
      onBack={onBack}
      title={root ? <ChartRootTitle name={nameOf(root)} sexCls={sexClass(root.sex)} years={lifespanOf(root)} kind={t("calendar.button")} /> : t("calendar.button")}
      controlsLeft={kindSwitcher}
    >
      <style>{CALENDAR_CSS}</style>
      <div className="cal-wizard">
        <div className="cal-panel">
          <div className="cal-steps">
            <button type="button" className="nav-btn" disabled={step === 0 || opening} onClick={() => setStep(step - 1)}>{t("calendar.prev")}</button>
            <span className="cal-step-label" aria-busy={opening}>
              {stepLabel}
              {opening && <span className="spinner" aria-hidden="true" />}
            </span>
            <button type="button" className="nav-btn" disabled={step === REVIEW_STEP || opening} onClick={() => (step === BACK_STEP ? openReview() : setStep(step + 1))}>{t("calendar.next")}</button>
          </div>
          <div className="cal-panel-body">{panel}</div>
          {step !== REVIEW_STEP && (
            <button type="button" className="link-button cal-to-review" disabled={opening} onClick={openReview}>{t("calendar.toReview")}</button>
          )}
          {!persistWorkspace && <p className="settings-hint">{t("calendar.notKept")}</p>}
        </div>
        <div className={`cal-preview cal-preview-${format}`}>
          {step === REVIEW_STEP ? preview : <div className="cal-sheet">{preview}</div>}
        </div>
      </div>
    </ChartPage>
  );
}

/** Choose what fills a page's picture area: photos — a suggested person's, or
 *  files of your own, up to {@link MAX_PHOTOS}, laid out as a collage when
 *  there are several — or a chart. */
function PicturePicker({
  people, value, onChange, personPhoto, words,
}: {
  people: string[];
  value: Picture;
  onChange: (pic: Picture) => void;
  personPhoto: (id: string) => PagePhoto | undefined;
  words: PersonWords;
}) {
  const { t } = useTranslation();
  const media = useMediaFolder();
  const fileRef = useRef<HTMLInputElement>(null);
  const photos = value.kind === "photos" ? value : { kind: "photos" as const, items: [], collage: "scattered" as CollageStyle };
  const toggle = (it: PhotoItem) => {
    const has = photos.items.some((x) => sameItem(x, it));
    const items = has ? photos.items.filter((x) => !sameItem(x, it)) : [...photos.items, it].slice(-MAX_PHOTOS);
    onChange({ ...photos, items });
  };
  const files = photos.items.filter((x): x is Extract<PhotoItem, { kind: "file" }> => x.kind === "file");
  return (
    <div className="cal-picture-picker">
      <label className="cal-field">
        <span>{t("calendar.picture")}</span>
        <SelectMenu
          value={value.kind}
          onChange={(v) => {
            const k = v as Picture["kind"];
            onChange(k === "photos" ? photos : { kind: k });
          }}
          options={PICTURE_KINDS.map((k) => ({ value: k, label: t(`calendar.picture.${k}`) }))}
        />
      </label>
      {value.kind === "photos" && (
        <>
          <div className="cal-photo-picker">
            {people.map((id) => {
              const p = personPhoto(id);
              const active = photos.items.some((x) => x.kind === "person" && x.id === id);
              return (
                <button key={id} type="button" aria-pressed={active} className={`cal-thumb${active ? " active" : ""}`} title={words.name(id)} onClick={() => toggle({ kind: "person", id })}>
                  {p ? <img src={p.url} alt="" /> : <span>{words.given(id)}</span>}
                </button>
              );
            })}
            {files.map((f) => (
              <button key={f.url} type="button" aria-pressed className="cal-thumb active" title={f.name} onClick={() => toggle(f)}>
                <img src={f.url} alt="" />
              </button>
            ))}
            <button type="button" className="nav-btn" onClick={() => fileRef.current?.click()}>{t("calendar.photo.own")}</button>
            <button type="button" className={`nav-btn${photos.items.length ? "" : " active"}`} onClick={() => onChange({ ...photos, items: [] })}>{t("calendar.photo.none")}</button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                const added = [...(e.target.files ?? [])].map((f): PhotoItem => ({ kind: "file", url: URL.createObjectURL(f), name: f.name }));
                if (added.length) onChange({ ...photos, items: [...photos.items, ...added].slice(-MAX_PHOTOS) });
                e.target.value = "";
              }}
            />
          </div>
          <p className="settings-hint">{t("calendar.photo.max", { n: MAX_PHOTOS })}</p>
          {photos.items.length > 1 && (
            <Segmented
              label={t("calendar.collage")}
              value={photos.collage}
              onChange={(collage) => onChange({ ...photos, collage })}
              items={COLLAGE_STYLES.map((k) => ({ key: k, label: t(`calendar.collage.${k}`) }))}
            />
          )}
          {!media.folderName && (
            <p className="settings-hint">
              {t("calendar.photo.noFolder")}{" "}
              <button type="button" className="link-button" onClick={() => void media.openFolder()}>{t("calendar.photo.linkFolder")}</button>
            </p>
          )}
        </>
      )}
    </div>
  );
}
