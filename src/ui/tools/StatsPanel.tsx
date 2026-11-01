import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import { computeKinship, computeLineSides } from "../../tools/batch";
import { buildStatsFacts, type StatsFacts } from "../../stats/facts";
import { applyCountry, DEFAULT_SCOPE, narrowScoped, scopeFacts, STATS_WHO, type StatsScope } from "../../stats/scope";
import {
  ADULT_AGE,
  CHILD_AGE,
  OVERVIEW_TOP,
  familyStats,
  lifespanStats,
  namesStats,
  overview,
  type Bucket,
  type CenturyPoint,
  type Share,
} from "../../stats/aggregate";
import { birthStats, deathStats, occupationStats } from "../../stats/vitals";
import { migrationStats } from "../../stats/migration";
import { COUPLE_KINSHIP, lineageStats, relatedCouples, type CoupleKinship } from "../../stats/lineage";
import { researchStats, type SourcedTag } from "../../stats/research";
import { eventDisplayLabel, familyEventLabel } from "../../gedcom/eventTags";
import { tipProps } from "../IconTip";
import { InfoIcon } from "../icons/InfoIcon";
import { FileTextIcon, ImageIcon } from "../icons/FormatIcons";
import { ExportMenu, type ExportItem } from "../ExportMenu";
import { exportStats } from "./statsSvg";
import { ChartIcon } from "../icons/ChartIcon";
import { DownloadIcon } from "../icons/DownloadIcon";
import { downloadText, savedName } from "../download";
import { csvStyleFor, percentOf, toCsv } from "../../stats/csv";
import { lifespanOf } from "../../gedcom/lifespan";
import { nameTypeLabel } from "../../match/relatives";
import { useHomeCountry } from "../DatasetDerivations";
import { PersonLink } from "../PersonLink";
import { StartPersonSelector } from "../StartPersonSelector";
import { useNameOf } from "../SettingsContext";
import { sexClass } from "../sex";
import { useVirtualList } from "../useVirtualList";
import { Segmented } from "../Segmented";
import { CountryChips, type CountryChip } from "./CountryChips";
import { countryFacetLabel, countryFacetName, flagEmoji } from "../../geo/placeCountry";
import { countryOf } from "../../tools/geocode";
import { ToolsLoading } from "./shared";
import { ToolSummary } from "./ToolSummary";
import { BarList, ColumnChart, PairBarList, StackedColumnChart, StatTile, toneClass, type BarRow, type Column, type PairRow, type StackedColumn, type StackTone, type Tone } from "./StatsCharts";
import type { ToolView } from "../ToolsView";

/** The statistics pages; the overview is the tool's front page. */
const PAGES = ["tree", "names", "lifespan", "families", "births", "deaths", "occupations", "migration", "generations", "research"] as const;
type Page = (typeof PAGES)[number];
/** The bar whose people are listed: which card, which bar, and who. */
interface Pick {
  card: string;
  key: string;
  title: string;
  ids: string[];
  /** The ids are family records, listed as their couples. */
  families: boolean;
}


/** Completeness grades: at least 90 % is good, at least 50 % fair, anything less poor. */
const gradeOf = (part: number): "good" | "fair" | "poor" => (part >= 0.9 ? "good" : part >= 0.5 ? "fair" : "poor");

/** A place by its own name, with its country as a flag; the whole value is the tip. */
function shortPlace(value: string, home: string): string {
  const first = value.split(",").map((p) => p.trim()).find(Boolean) ?? value;
  // The country is read as the country chips read it: named, else the home one.
  const code = countryOf(value, home);
  return /^[a-z]{2}$/i.test(code) ? `${flagEmoji(code)} ${first}` : first;
}

/** Cards that share another card's explanation: the overview's top five are the names page's lists. */
const ABOUT_ALIAS: Record<string, string> = {
  topSurnames: "surnames", topMale: "givenMale", topFemale: "givenFemale", topBirthPlaces: "birthPlaces",
  ageAtDeathMale: "ageAtDeath", ageAtDeathFemale: "ageAtDeath", lifeByCenturyMale: "lifeByCentury", lifeByCenturyFemale: "lifeByCentury",
};

/** A repeated ancestor's generations, each once, with how often they hold it: "7, 8", "8 ×2". */
function gensLabel(gens: number[]): string {
  const counts = new Map<number, number>();
  for (const g of gens) counts.set(g, (counts.get(g) ?? 0) + 1);
  return [...counts].map(([g, n]) => (n > 1 ? `${g} ×${n}` : String(g))).join(", ");
}

/** Whether the filters are unfolded — the reader's own layout, kept per browser. */
const FILTERS_KEY = "gedmerge.statsFiltersOpen";
function readFiltersOpen(): boolean {
  try {
    return localStorage.getItem(FILTERS_KEY) !== "0";
  } catch {
    return true;
  }
}
function writeFiltersOpen(open: boolean): void {
  try {
    localStorage.setItem(FILTERS_KEY, open ? "1" : "0");
  } catch {
    // Storage may be off (private window); the toggle still works for the session.
  }
}

/** Let React paint the "working…" state before the first walk over the file. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The fact rows last built for a file, at the edit version and home country
 * they were built at. The panel mounts only while its tool is open, so without
 * this every visit to Statistics walked the whole file again.
 */
const factsCache = new WeakMap<Dataset, { version: number; home: string; facts: StatsFacts }>();

function cachedFacts(dataset: Dataset, version: number, home: string): StatsFacts | undefined {
  const hit = factsCache.get(dataset);
  return hit && hit.version === version && hit.home === home ? hit.facts : undefined;
}

export function StatsPanel({
  dataset,
  editVersion,
  onNavigate,
  onOpenRelationship,
  fileName,
  active,
  startId,
  view,
  onViewChange,
}: {
  dataset: Dataset;
  editVersion: number;
  onNavigate: (id: string) => void;
  onOpenRelationship: (fromId: string, toId: string) => void;
  /** The open file's name, which the CSV downloads are named after. */
  fileName: string;
  active: boolean;
  startId?: string;
  view: ToolView;
  onViewChange: (view: ToolView) => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const home = useHomeCountry();
  const [scope, setScope] = useState<StatsScope>(DEFAULT_SCOPE);
  const [pick, setPick] = useState<Pick | null>(null);
  const nameOf = useNameOf();
  // The ranked lists unfolded to their full length, by card.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  // A return with the file unchanged has its rows already: no loading pass.
  const [ready, setReady] = useState(() => cachedFacts(dataset, editVersion, home) !== undefined);
  const page: Page = (PAGES as readonly string[]).includes(view) ? (view as Page) : "tree";

  useEffect(() => {
    if (!active || ready) return;
    let cancelled = false;
    void nextTick().then(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [active, ready]);

  // One walk over the file per edit; every scope and page reads its rows. The
  // edits made while Tools is behind another mode are caught up with when it
  // returns — and only then, so a return without an edit walks nothing.
  const [seenVersion, setSeenVersion] = useState(editVersion);
  useEffect(() => { if (active) setSeenVersion(editVersion); }, [active, editVersion]);
  // seenVersion keys the rows: the dataset is mutated in place.
  const facts = useMemo(() => {
    if (!ready) return undefined;
    const hit = cachedFacts(dataset, seenVersion, home);
    if (hit) return hit;
    const built = buildStatsFacts(dataset, home);
    factsCache.set(dataset, { version: seenVersion, home, facts: built });
    return built;
  }, [ready, dataset, seenVersion, home]);
  const lined = scope.who !== "all";
  // Whose line the statistics follow: the app's start person until another is
  // picked here. The choice is the statistics' own and moves nothing else.
  const [ownStart, setOwnStart] = useState<string | undefined>();
  const statsStart = ownStart && dataset.individuals.has(ownStart) ? ownStart : startId;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- seenVersion: the dataset is mutated in place
  const kinship = useMemo(() => (lined && statsStart ? computeKinship(dataset, statsStart) : null), [lined, dataset, statsStart, seenVersion]);
  // The fields show each keystroke at once; the numbers follow when React has
  // a moment — a year typed digit by digit (1, 18, 185, 1850) re-scopes once.
  const settledScope = useDeferredValue(scope);
  const base = useMemo(() => (facts ? scopeFacts(facts, settledScope, kinship, statsStart) : []), [facts, settledScope, kinship, statsStart]);
  const [filtersOpen, setFiltersOpen] = useState(readFiltersOpen);
  const toggleFilters = () => setFiltersOpen((open) => { writeFiltersOpen(!open); return !open; });
  const scoped = useMemo(() => (facts ? applyCountry(facts, base, settledScope) : undefined), [facts, base, settledScope]);
  const chips = useMemo(() => {
    const byCode = new Map<string, CountryChip>();
    for (const p of base) {
      let chip = byCode.get(p.country);
      if (!chip) byCode.set(p.country, (chip = { code: p.country, count: 0 }));
      chip.count++;
    }
    return [...byCode.values()];
  }, [base]);

  const ov = useMemo(() => (scoped && page === "tree" ? overview(scoped) : undefined), [scoped, page]);
  const names = useMemo(() => (scoped && page === "names" ? namesStats(scoped) : undefined), [scoped, page]);
  const life = useMemo(() => (scoped && page === "lifespan" ? lifespanStats(scoped) : undefined), [scoped, page]);
  const fams = useMemo(() => (scoped && page === "families" ? familyStats(scoped) : undefined), [scoped, page]);
  const related = useMemo(() => (scoped && page === "families" ? relatedCouples(scoped.byId, scoped.families) : undefined), [scoped, page]);
  const relatedIds = useMemo(() => (related ? COUPLE_KINSHIP.flatMap((k) => related.byKind[k]) : []), [related]);
  const births = useMemo(() => (scoped && page === "births" ? birthStats(scoped) : undefined), [scoped, page]);
  const deaths = useMemo(() => (scoped && page === "deaths" ? deathStats(scoped) : undefined), [scoped, page]);
  const jobs = useMemo(() => (scoped && page === "occupations" ? occupationStats(scoped) : undefined), [scoped, page]);
  const moves = useMemo(() => (scoped && page === "migration" ? migrationStats(scoped) : undefined), [scoped, page]);
  const research = useMemo(() => (scoped && page === "research" ? researchStats(scoped) : undefined), [scoped, page]);
  // The same, for the father's and the mother's side of the line's person apart.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- seenVersion: the dataset is mutated in place
  const sides = useMemo(() => (page === "research" && statsStart ? computeLineSides(dataset, statsStart) : null), [page, dataset, statsStart, seenVersion]);
  const researchBySide = useMemo(() => (scoped && sides ? {
    paternal: researchStats(narrowScoped(scoped, (id) => sides.get(id) === "paternal")),
    maternal: researchStats(narrowScoped(scoped, (id) => sides.get(id) === "maternal")),
  } : undefined), [scoped, sides]);
  // Generations are one person's tree, so they follow the line's person whatever the scope.
  const lineage = useMemo(() => (facts && statsStart && page === "generations" ? lineageStats(facts, statsStart) : undefined), [facts, statsStart, page]);

  // A list belongs to the numbers it was picked from.
  useEffect(() => setPick(null), [scope, page, facts]);

  if (!facts || !scoped) return <ToolsLoading label={t("stats.running")} />;

  const num = (n: number) => n.toLocaleString(lang);
  const dec = (n: number) => n.toLocaleString(lang, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const pct = (part: number, of: number) =>
    of ? (part / of).toLocaleString(lang, { style: "percent", maximumFractionDigits: 0 }) : "–";
  const set = (patch: Partial<StatsScope>) => setScope((s) => ({ ...s, ...patch }));
  const choose = (card: string, key: string, title: string, ids: string[], families = false) =>
    setPick((p) => (p?.card === card && p.key === key ? null : { card, key, title, ids, families }));
  const pickedIn = (card: string) => (pick?.card === card ? pick.key : undefined);

  const signed = (n: number) => (n < 0 ? `−${-n}` : String(n));
  const rangeLabel = (b: Bucket) =>
    b.lo === undefined ? `<${signed(b.hi! + 1)}`
      : b.hi === undefined ? `${signed(b.lo)}+`
        : b.lo === b.hi ? signed(b.lo) : `${signed(b.lo)}–${signed(b.hi)}`;
  const centuryLabel = (c: number) => t("stats.century", { from: c, to: c + 99, n: c / 100 + 1 });

  // The data behind each card, as table rows for its CSV download — registered
  // as the charts render (before the card around them), built only on a click.
  const csvOf = new Map<string, () => (string | number)[][]>();
  /** Register a card's export rows and hand its body back. */
  const withCsv = (card: string, rows: () => (string | number)[][], body: ReactNode) => {
    csvOf.set(card, rows);
    return body;
  };

  /** A column chart over buckets; picking a column lists its rows. */
  const buckets = (card: string, title: string, list: Bucket[], opts: { families?: boolean; tone?: Tone; label?: (b: Bucket) => string; labelEvery?: number; tipLabel?: (b: Bucket) => string } = {}) => {
    const label = opts.label ?? rangeLabel;
    // The hover text and the list's title name the bucket in full where the axis abbreviates it.
    const full = opts.tipLabel ?? label;
    csvOf.set(card, () => [[title, t("stats.csv.count")], ...list.map((b) => [full(b), b.count])]);
    const columns: Column[] = list.map((b) => ({ key: b.key, label: label(b), value: b.count, count: b.count, tip: `${full(b)}: ${num(b.count)}` }));
    return (
      <ColumnChart
        columns={columns}
        tone={opts.tone}
        labelEvery={opts.labelEvery}
        format={num}
        picked={pickedIn(card)}
        onPick={(key) => {
          const b = list.find((x) => x.key === key)!;
          choose(card, key, `${title} — ${full(b)}`, b.ids, opts.families);
        }}
      />
    );
  };

  /** A column chart of a by-century average or share. */
  const centuries = (card: string, title: string, points: CenturyPoint[], format: (v: number) => string, opts: { families?: boolean; tone?: Tone } = {}) => withCsv(
    card,
    () => [[t("stats.centuryCol"), title, t("stats.csv.counted")], ...points.map((p) => [`${p.century}–${p.century + 99}`, Math.round(p.value * 10) / 10, p.n])],
    <ColumnChart
      tone={opts.tone}
      columns={points.map((p) => ({
        key: String(p.century),
        label: centuryLabel(p.century),
        value: p.value,
        count: p.ids.length,
        empty: false,
        tip: t("stats.centuryTip", { from: p.century, to: p.century + 99, value: format(p.value), n: num(p.n) }),
      }))}
      format={format}
      labelEvery={points.length > 8 ? 2 : 1}
      picked={pickedIn(card)}
      onPick={(key) => {
        const p = points.find((x) => String(x.century) === key)!;
        choose(card, key, `${title} — ${centuryLabel(p.century)}`, p.ids, opts.families);
      }}
    />
  );

  /** A ranked list of names. */
  // How long each cut list really is, filled as the lists render (before the
  // card around them), so the card can offer the rest from its header.
  const moreOf = new Map<string, number>();
  const listLimit = (card: string, count: number, limit: number) => {
    if (count > limit) moreOf.set(card, count);
    return expanded.has(card) ? undefined : limit;
  };
  const toggleExpanded = (card: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (!next.delete(card)) next.add(card);
    return next;
  });
  const ranked = (card: string, title: string, list: Bucket[], limit: number, tone?: Tone, places = false, families = false) => withCsv(
    card,
    () => [[title, t("stats.csv.count")], ...list.map((b) => [b.label!, b.count])],
    <BarList
      tone={tone}
      picked={pickedIn(card)}
      // Rows only for what is shown: a file's surnames or places run to tens of
      // thousands, and a place's short label costs a lookup each.
      max={list.reduce((m, b) => Math.max(m, b.count), 1)}
      itemsKey={list}
      rows={list.slice(0, listLimit(card, list.length, limit)).map((b) => ({
        key: b.key,
        // A place reads by its own name and its country's flag; the whole value is the tip.
        label: places ? shortPlace(b.label!, home) : b.label,
        tip: places ? b.label : undefined,
        value: b.count,
        display: num(b.count),
        count: b.count,
      }))}
      onPick={(key) => {
        const b = list.find((x) => x.key === key)!;
        choose(card, key, `${title} — ${b.label}`, b.ids, families);
      }}
    />
  );

  /** Shares as percentage bars; a pick lists the rows `missing` holds when `listMissing`. */
  const shares = (card: string, items: { key: string; label: string; share: Share; tone?: Tone }[], listMissing: boolean, graded = false) => withCsv(
    card,
    () => [["", t("stats.csv.has"), t("stats.csv.of"), t("stats.csv.share")], ...items.map(({ label, share }) => [label, share.n, share.of, percentOf(share.n, share.of)])],
    <BarList
      max={100}
      picked={pickedIn(card)}
      // A share of nobody (no deceased to have a death date) is no row at all.
      rows={items.filter(({ share }) => share.of > 0).map<BarRow>(({ key, label, share, tone }) => ({
        key,
        label,
        tone,
        status: graded && share.of ? gradeOf(share.n / share.of) : undefined,
        value: share.of ? (100 * share.n) / share.of : 0,
        display: pct(share.n, share.of),
        tip: t("stats.shareTip", { n: num(share.n), of: num(share.of) }),
        count: listMissing ? share.missing.length : share.n,
      }))}
      onPick={(key) => {
        const item = items.find((x) => x.key === key)!;
        const title = listMissing ? t("stats.missingTitle", { what: item.label }) : item.label;
        choose(card, key, title, listMissing ? item.share.missing : item.share.ids);
      }}
    />
  );

  /** What a click on the card does, said once in its tip: a list of who is
   *  missing the item, of who carries the name or occupation, or of who is in the bar. */
  const clickHint = (id: string) =>
    id === "complete" ? t("stats.click.missing")
      : id === "byCentury" ? t("stats.click.chip")
        : id === "jobsByCentury" ? t("stats.click.job")
        : id === "oldest" ? ""
          : id === "repeatedAncestors" ? t("stats.click.person")
          : id === "sourcedByTag" ? t("stats.click.unsourced")
          : t("stats.click.bar");
  /** Whose numbers a picture shows, for its subtitle: the line and its person,
   *  and every filter in force; empty for the whole file unfiltered. */
  const scopeLine = () => {
    const person = statsStart ? dataset.individuals.get(statsStart) : undefined;
    const name = person ? nameOf(person) : "";
    const parts: string[] = [];
    if (page === "generations") {
      if (name) parts.push(name);
    } else {
      if (lined) parts.push(name ? `${t(`stats.who.${scope.who}`)}: ${name}` : t(`stats.who.${scope.who}`));
      if (scope.sex !== "all") parts.push(t(`stats.sex.${scope.sex}`));
      if (scope.from !== undefined || scope.to !== undefined) parts.push(`${t("stats.born")} ${scope.from ?? ""}–${scope.to ?? ""}`);
      if (scope.place.trim()) parts.push(scope.place.trim());
      if (scope.country !== null) parts.push(countryName(scope.country));
    }
    return parts.join(" · ");
  };
  /** Downloads of what `root` shows: its numbers as CSV where it has them, and
   *  the picture as SVG or PNG. */
  const exportsOf = (name: string, title: string, root: () => HTMLElement | null, csv?: () => (string | number)[][]): ExportItem[] => {
    const base = `${fileName.replace(/\.[^.]+$/, "")}.${name}`;
    const picture = (format: "svg" | "png") => () => {
      const node = root();
      if (node) void exportStats(node, format, base, { title, fileName: base, subtitle: scopeLine() || undefined });
    };
    return [
      ...(csv ? [{ key: "csv", icon: <FileTextIcon />, label: t("export.csv"), onSelect: () => downloadText(savedName(fileName, `${name}.csv`), toCsv(csv(), csvStyleFor(lang)), "text/csv;charset=utf-8") }] : []),
      { key: "svg", icon: <ImageIcon />, label: t("export.svg"), onSelect: picture("svg") },
      { key: "png", icon: <ImageIcon />, label: t("export.png"), onSelect: picture("png") },
    ];
  };
  const cardExports = (id: string, title: string) =>
    exportsOf(id, title, () => document.querySelector<HTMLElement>(`[data-stats-card="${id}"]`), csvOf.get(id));
  const card = (id: string, title: string, note: ReactNode, body: ReactNode, wide = false) => {
    // What the numbers are and how they were taken — one tip per card.
    const about = `stats.about.${ABOUT_ALIAS[id] ?? id}`;
    // A list cut short offers the rest from the corner, beside the tip.
    const more = moreOf.get(id);
    const open = expanded.has(id);
    return (
    <section className={`stats-card${wide ? " wide" : ""}`} key={id} data-stats-card={id}>
      <header className="stats-card-head">
        <h3>{title}</h3>
        {note && <span className="stats-card-note">{note}</span>}
        <span className="stats-card-tools">
          <ExportMenu compact items={cardExports(id, title)} />
          {more !== undefined && (
            <button
              type="button"
              className="stats-info"
              aria-pressed={open}
              onClick={() => toggleExpanded(id)}
              {...tipProps(open ? t("stats.showFewer") : t("stats.showAll", { count: more }))}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {open
                  ? <><polyline points="7,4 12,9 17,4" /><polyline points="7,20 12,15 17,20" /></>
                  : <><polyline points="7,9 12,4 17,9" /><polyline points="7,15 12,20 17,15" /></>}
              </svg>
            </button>
          )}
          {i18n.exists(about) && (
            <button type="button" className="stats-info" {...tipProps([t(about), clickHint(id)].filter(Boolean).join("\n\n"), { heading: title })}>
              <InfoIcon size={14} />
            </button>
          )}
        </span>
      </header>
      {body}
      {pick?.card === id && (
        <PickList key={`${pick.card}:${pick.key}`} pick={pick} dataset={dataset} fileName={fileName} onNavigate={onNavigate} onClose={() => setPick(null)} onRelate={id === "relatedCouples" ? onOpenRelationship : undefined} />
      )}
    </section>
  );
  };
  const total = (list: Bucket[]) => list.reduce((a, b) => a + b.count, 0);
  const monthLabel = (b: Bucket) => new Date(2000, b.lo! - 1, 1).toLocaleString(lang, { month: "short" });
  const countryName = (code: string) => (code ? countryFacetLabel(code, lang) : t("tools.geocode.countryUnknown"));
  // A signed range is too wide for a column: the axis names its lower bound, the tip the range.
  const lowerBound = (b: Bucket) => (b.lo === undefined ? rangeLabel(b) : b.hi === undefined ? `${signed(b.lo)}+` : signed(b.lo));
  const distanceLabel = (b: Bucket) =>
    b.lo === 0 ? t("stats.samePlace") : t("stats.km", { value: b.hi === undefined ? `${num(b.lo!)}+` : `${num(b.lo!)}–${num(b.hi)}` });
  /** A move between countries: the two countries' names, flags first. */
  const countryMove = (key: string) => {
    const [from, to] = key.split(">");
    return `${countryName(from)} → ${countryName(to)}`;
  };
  const periodLabel = (b: Bucket) => String(b.lo);
  /** Label about a dozen periods however many there are. */
  const periodStep = (list: Bucket[]) => Math.max(1, Math.ceil(list.length / 12));
  /** Rows per period, each column split in two (men and women, first and later
   *  marriages), the whole count on top; a part lists its own rows. */
  const stackedPeriods = (card: string, title: string, list: Bucket[], names: [string, string], split: (ids: string[]) => [string[], string[]], opts: { tones?: [StackTone, StackTone]; families?: boolean } = {}) => {
    const parts = list.map((b) => split(b.ids));
    csvOf.set(card, () => [[title, ...names, t("stats.csv.count")], ...list.map((b, i) => [rangeLabel(b), parts[i][0].length, parts[i][1].length, b.count])]);
    const part = (b: Bucket, name: string, ids: string[]) => ({ value: ids.length, tip: `${rangeLabel(b)} — ${name}: ${num(ids.length)} / ${num(b.count)}`, count: ids.length });
    return (
      <StackedColumnChart
        names={names}
        tones={opts.tones}
        labelEvery={periodStep(list)}
        picked={pickedIn(card)}
        columns={list.map<StackedColumn>((b, i) => ({
          key: b.key,
          label: periodLabel(b),
          lower: part(b, names[0], parts[i][0]),
          upper: part(b, names[1], parts[i][1]),
          top: b.count ? num(b.count) : undefined,
        }))}
        onPick={(key, which) => {
          const i = list.findIndex((b) => b.key === key);
          const w = which === "lower" ? 0 : 1;
          choose(card, `${key}:${which}`, `${title} — ${rangeLabel(list[i])} — ${names[w]}`, parts[i][w], opts.families);
        }}
      />
    );
  };
  /** Split people into men and women; anyone else is in the column's total only. */
  const bySex = (ids: string[]): [string[], string[]] => [
    ids.filter((id) => scoped?.byId.get(id)?.sex === "M"),
    ids.filter((id) => scoped?.byId.get(id)?.sex === "F"),
  ];

  /** Top names or occupations per century, as chips that list their people. */
  const centuryTable = (id: string, itemHead: string, columns: { head: string; tone?: Tone }[], rows: { century: number; cells: Bucket[][] }[]) => withCsv(
    id,
    // With a column per sex, the sex gets a column of its own in the export.
    () => columns.length > 1
      ? [[t("stats.centuryCol"), t("stats.sex"), itemHead, t("stats.csv.count")], ...rows.flatMap((row) => row.cells.flatMap((list, col) => list.map((b) => [`${row.century}–${row.century + 99}`, columns[col].head, b.label!, b.count])))]
      : [[t("stats.centuryCol"), itemHead, t("stats.csv.count")], ...rows.flatMap((row) => row.cells[0].map((b) => [`${row.century}–${row.century + 99}`, b.label!, b.count]))],
    <table className="stats-table">
      <thead>
        <tr><th>{t("stats.centuryCol")}</th>{columns.map((c) => <th key={c.head}>{c.head}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.century}>
            <th scope="row">{centuryLabel(row.century)}</th>
            {row.cells.map((list, col) => (
              <td key={col} className={toneClass(columns[col].tone).trim() || undefined}>
                {list.map((b) => {
                  const key = `${row.century}:${col}:${b.key}`;
                  return (
                    <button
                      key={b.key}
                      type="button"
                      className={`stats-name-chip${pick?.card === id && pick.key === key ? " picked" : ""}`}
                      onClick={() => choose(id, key, `${b.label} — ${centuryLabel(row.century)}`, b.ids)}
                    >
                      {b.label} <span className="muted">{num(b.count)}</span>
                    </button>
                  );
                })}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
  const people = scoped.people.length;
  // A scope of one sex colours every chart that is not already about one.
  const scopeTone: Tone | undefined = scope.sex === "M" ? "male" : scope.sex === "F" ? "female" : undefined;
  // Generations are one person's tree: the page reads neither the line nor the
  // filters, so it offers only the person.
  const personal = page === "generations";
  // How many filters narrow the scope — shown on the toggle, so a folded
  // filter row still says it is in force.
  const activeFilters = [
    scope.sex !== "all",
    scope.from !== undefined || scope.to !== undefined,
    !!scope.place.trim(),
    scope.country !== null,
    scope.approx,
  ].filter(Boolean).length;
  const families = scoped.families.length;

  // The export rows of the cards drawn without the shared helpers above.
  const personName = (id: string) => {
    const indi = dataset.individuals.get(id);
    return indi ? nameOf(indi) : id;
  };
  if (ov) csvOf.set("topBirthCountries", () => [[t("stats.topBirthCountries"), t("stats.csv.count")], ...ov.topBirthCountries.map((b) => [countryName(b.key), b.count])]);
  if (life) csvOf.set("oldest", () => [[t("stats.csv.person"), t("stats.ageAtDeath")], ...life.oldest.map((o) => [personName(o.id), o.age])]);
  if (deaths) csvOf.set("causeAge", () => [[t("stats.causes"), t("stats.meanAgeAtDeath"), t("stats.csv.counted")], ...deaths.ageByCause.map((c) => [c.label, Math.round(c.value * 10) / 10, c.ids.length])]);
  if (moves) csvOf.set("countryMoves", () => [[t("stats.csv.from"), t("stats.csv.to"), t("stats.csv.count")], ...moves.countryMoves.map((b) => {
    const [from, to] = b.key.split(">");
    return [countryName(from), countryName(to), b.count];
  })]);
  if (lineage) {
    csvOf.set("ancestorsGen", () => [[t("stats.csv.generation"), t("stats.csv.has"), t("stats.csv.of")], ...lineage.ancestors.map((g) => [g.gen, g.filled, g.slots])]);
    csvOf.set("ancestorsSide", () => [
      [t("stats.csv.generation"), t("stats.side.paternal"), t("stats.side.maternal"), t("stats.csv.of")],
      ...lineage.ancestors.map((g) => [g.gen, g.paternal.filled, g.maternal.filled, g.slots / 2]),
    ]);
    csvOf.set("walls", () => [[t("stats.csv.generation"), t("stats.csv.person"), t("stats.walls")], ...lineage.walls.map((w) => [w.gen, personName(w.id), t(w.father && w.mother ? "stats.wall.both" : w.father ? "stats.wall.father" : "stats.wall.mother")])]);
    csvOf.set("repeatedAncestors", () => [[t("stats.csv.person"), t("stats.csv.places"), t("stats.csv.generation")], ...lineage.repeated.map((r) => [personName(r.id), r.count, gensLabel(r.gens)])]);
    csvOf.set("descendantsGen", () => [[t("stats.csv.generation"), t("stats.csv.count")], ...lineage.descendants.map((g) => [g.gen, g.ids.length])]);
  }
  /** A research row's event, named as a family's where it stands on families. */
  const tagLabel = (s: SourcedTag) => (s.families ? familyEventLabel(s.tag, t) : eventDisplayLabel(s.tag, t));
  if (research) csvOf.set("sourcedByTag", () => [[t("stats.csv.event"), t("stats.csv.has"), t("stats.csv.of"), t("stats.csv.share")], ...research.byTag.map((s) => [tagLabel(s), s.sourced, s.events, percentOf(s.sourced, s.events)])]);
  if (research && researchBySide) csvOf.set("sourcedBySide", () => [
    [t("stats.csv.event"), t("stats.side.paternal"), t("stats.side.maternal")],
    ...research.byTag.map((s) => {
      const side = (r: typeof research) => {
        const x = r.byTag.find((y) => y.key === s.key);
        return x ? percentOf(x.sourced, x.events) : "";
      };
      return [tagLabel(s), side(researchBySide.paternal), side(researchBySide.maternal)];
    }),
  ]);
  if (related) csvOf.set("relatedCouples", () => [[t("stats.relatedCouples"), t("stats.csv.count")], ...COUPLE_KINSHIP.map((k) => [t(`stats.kin.${k}`), related.byKind[k].length])]);

  return (
    <div className="tools-stats-panel">
      {/* One row says which numbers and whose: the page, the line, the line's
          person, and how many of the file that leaves. The filters below it
          fold away. */}
      <div className="stats-head">
        <Segmented
          label={t("stats.pages")}
          value={page}
          onChange={(p) => onViewChange(p)}
          items={PAGES.map((p) => ({ key: p, label: t(`stats.page.${p}`) }))}
        />
        {/* The line and whose line it is stay side by side; the count and the
            filter toggle wrap away first. */}
        <div className="stats-line">
          {!personal && (
          <Segmented
            label={t("stats.who")}
            value={scope.who}
            onChange={(who) => set({ who })}
            items={STATS_WHO.map((w) => ({ key: w, label: t(`stats.who.${w}`) }))}
          />
          )}
          {(lined || page === "generations" || page === "research") && (
            <div className={`stats-start${ownStart && ownStart !== startId ? " own" : ""}`}>
              <StartPersonSelector
                individuals={dataset.individuals}
                version={seenVersion}
                startId={statsStart}
                onChange={setOwnStart}
                placeholder={t("stats.startPick")}
                tooltip={t("stats.startHint")}
                // A person picked here gives way to the app's start person
                // again at a click on the house.
                onStartClick={ownStart && ownStart !== startId ? () => setOwnStart(undefined) : undefined}
                startClickTitle={t("stats.startReset")}
              />
            </div>
          )}
        </div>
        {!personal && (
        <div className="stats-head-end">
          <ToolSummary>{t("stats.summary", { count: facts.people.length, scoped: num(people) })}</ToolSummary>
          <button
            type="button"
            className={`tools-chip${activeFilters ? " active" : ""}`}
            aria-expanded={filtersOpen}
            onClick={toggleFilters}
          >
            <svg className="stats-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="9,5 16,12 9,19" />
            </svg>
            {t("stats.filters")}
            {activeFilters > 0 && <span className="tools-chip-count"> {activeFilters}</span>}
          </button>
        </div>
        )}
        {/* The whole page as one picture: every card as it stands. */}
        <span className={personal ? "stats-head-end" : undefined}>
          <ExportMenu items={exportsOf(page === "tree" ? "statistics" : `statistics-${page}`, `${t("tools.tool.stats")} — ${t(`stats.page.${page}`)}`, () => document.querySelector<HTMLElement>(".tools-stats-panel .stats-grid"))} />
        </span>
      </div>

      {filtersOpen && !personal && (
      <div className="stats-scope">
        <div className="stats-scope-row">
          <Segmented
            label={t("stats.sex")}
            value={scope.sex}
            onChange={(sex) => set({ sex })}
            items={(["all", "M", "F"] as const).map((s) => ({ key: s, label: t(`stats.sex.${s}`) }))}
          />
          <label className="stats-scope-years">
            {t("stats.born")}
            <YearInput value={scope.from} onChange={(from) => set({ from })} label={t("stats.bornFrom")} />
            –
            <YearInput value={scope.to} onChange={(to) => set({ to })} label={t("stats.bornTo")} />
          </label>
          <input
            type="search"
            className="tools-search-input stats-scope-place"
            placeholder={t("stats.place")}
            aria-label={t("stats.place")}
            value={scope.place}
            onChange={(e) => set({ place: e.target.value })}
          />
          <label className="tools-norm-check">
            <input type="checkbox" checked={scope.approx} onChange={(e) => set({ approx: e.target.checked })} />
            <span title={t("stats.approxHint")}>{t("stats.approx")}</span>
          </label>
        </div>
        <CountryChips
          chips={chips}
          all={base.length}
          active={scope.country}
          onPick={(country) => set({ country })}
          assumed={home || undefined}
        />
      </div>
      )}

      {people === 0 ? (
        <p className="tools-clean">{t("stats.nobody")}</p>
      ) : (
      <div className={`stats-grid${toneClass(scopeTone)}`}>
        {ov && (
          <>
            <section className="stats-card wide stats-tiles">
              <StatTile label={t("stats.people")} value={num(ov.people)} onClick={() => choose("tiles", "people", t("stats.people"), scoped.people.map((p) => p.id))} picked={pickedIn("tiles") === "people"} />
              <StatTile label={t("stats.families")} value={num(ov.families)} onClick={() => choose("tiles", "families", t("stats.families"), scoped.families.map((f) => f.id), true)} picked={pickedIn("tiles") === "families"} />
              {scope.sex !== "F" && <StatTile tone="male" label={t("stats.men")} value={num(ov.male.length)} sub={pct(ov.male.length, ov.people)} onClick={() => choose("tiles", "men", t("stats.men"), ov.male)} picked={pickedIn("tiles") === "men"} />}
              {scope.sex !== "M" && <StatTile tone="female" label={t("stats.women")} value={num(ov.female.length)} sub={pct(ov.female.length, ov.people)} onClick={() => choose("tiles", "women", t("stats.women"), ov.female)} picked={pickedIn("tiles") === "women"} />}
              {ov.unknownSex.length > 0 && (
                <StatTile label={t("stats.sexUnknown")} value={num(ov.unknownSex.length)} onClick={() => choose("tiles", "sexUnknown", t("stats.sexUnknown"), ov.unknownSex)} picked={pickedIn("tiles") === "sexUnknown"} />
              )}
              <StatTile label={t("stats.living")} value={num(ov.living.length)} onClick={() => choose("tiles", "living", t("stats.living"), ov.living)} picked={pickedIn("tiles") === "living"} />
              <StatTile label={t("stats.deceased")} value={num(ov.deceased.length)} onClick={() => choose("tiles", "deceased", t("stats.deceased"), ov.deceased)} picked={pickedIn("tiles") === "deceased"} />
              {ov.firstBirth && ov.lastBirth && (
                <StatTile label={t("stats.births")} value={`${ov.firstBirth.year}–${ov.lastBirth.year}`} onClick={() => choose("tiles", "span", t("stats.births"), [ov.firstBirth!.id, ov.lastBirth!.id])} picked={pickedIn("tiles") === "span"} />
              )}
              <StatTile label={t("stats.surnames")} value={num(ov.surnames)} />
              <StatTile label={t("stats.givenNames")} value={num(ov.givenNames)} />
              <StatTile label={t("stats.countries")} value={num(ov.countries)} />
              <StatTile label={t("stats.placesNamed")} value={num(ov.places)} />
              <StatTile label={t("stats.sourcesCited")} value={num(ov.sources)} />
              <StatTile label={t("stats.mediaLinked")} value={num(ov.media)} />
              {scope.sex !== "F" && ov.oldestMale && (
                <StatTile tone="male" label={t("stats.oldestMale")} value={t("stats.years", { count: ov.oldestMale.age })} sub={<NameLink dataset={dataset} id={ov.oldestMale.id} onNavigate={onNavigate} />} />
              )}
              {scope.sex !== "M" && ov.oldestFemale && (
                <StatTile tone="female" label={t("stats.oldestFemale")} value={t("stats.years", { count: ov.oldestFemale.age })} sub={<NameLink dataset={dataset} id={ov.oldestFemale.id} onNavigate={onNavigate} />} />
              )}
              {ov.ageAtDeath && (
                <StatTile label={t("stats.meanAgeAtDeath")} value={dec(ov.ageAtDeath.value)} />
              )}
              {ov.largestFamily && (
                <StatTile label={t("stats.largestFamily")} value={t("stats.children", { count: ov.largestFamily.children })} sub={<Couple dataset={dataset} id={ov.largestFamily.id} onNavigate={onNavigate} nameOnly />} />
              )}
              {scope.sex !== "F" && ov.mostChildrenMale && (
                <StatTile tone="male" label={t("stats.mostChildrenMale")} value={t("stats.children", { count: ov.mostChildrenMale.children })} sub={<NameLink dataset={dataset} id={ov.mostChildrenMale.id} onNavigate={onNavigate} />} />
              )}
              {scope.sex !== "M" && ov.mostChildrenFemale && (
                <StatTile tone="female" label={t("stats.mostChildrenFemale")} value={t("stats.children", { count: ov.mostChildrenFemale.children })} sub={<NameLink dataset={dataset} id={ov.mostChildrenFemale.id} onNavigate={onNavigate} />} />
              )}
              {ov.childrenPerFamily && (
                <StatTile label={t("stats.childrenPerFamily")} value={dec(ov.childrenPerFamily.value)} />
              )}
              {pick?.card === "tiles" && (
                <PickList key={`tiles:${pick.key}`} pick={pick} dataset={dataset} fileName={fileName} onNavigate={onNavigate} onClose={() => setPick(null)} />
              )}
            </section>
            {card("topSurnames", t("stats.topSurnames"), null, ranked("topSurnames", t("stats.surname"), ov.topSurnames, OVERVIEW_TOP))}
            {scope.sex !== "F" && card("topMale", t("stats.topGivenMale"), null, ranked("topMale", t("stats.givenName"), ov.topGivenMale, OVERVIEW_TOP, "male"))}
            {scope.sex !== "M" && card("topFemale", t("stats.topGivenFemale"), null, ranked("topFemale", t("stats.givenName"), ov.topGivenFemale, OVERVIEW_TOP, "female"))}
            {card("topBirthCountries", t("stats.topBirthCountries"), null, (
              <BarList
                picked={pickedIn("topBirthCountries")}
                rows={ov.topBirthCountries.map((b) => ({ key: b.key, label: countryName(b.key), value: b.count, display: num(b.count), count: b.count }))}
                onPick={(key) => {
                  const b = ov.topBirthCountries.find((x) => x.key === key)!;
                  choose("topBirthCountries", key, `${t("stats.topBirthCountries")} — ${countryName(key)}`, b.ids);
                }}
              />
            ))}
            {card("topBirthPlaces", t("stats.topBirthPlaces"), null, ranked("topBirthPlaces", t("stats.birthPlaces"), ov.topBirthPlaces, OVERVIEW_TOP, undefined, true))}
            {card("complete", t("stats.completeness"), null, shares("complete", [
              { key: "name", label: t("stats.has.name"), share: ov.completeness.name },
              { key: "birthDate", label: t("stats.has.birthDate"), share: ov.completeness.birthDate },
              { key: "birthPlace", label: t("stats.has.birthPlace"), share: ov.completeness.birthPlace },
              { key: "deathDate", label: t("stats.has.deathDate"), share: ov.completeness.deathDate },
              { key: "place", label: t("stats.has.place"), share: ov.completeness.place },
              { key: "mapped", label: t("stats.has.mapped"), share: ov.completeness.mapped },
              { key: "parents", label: t("stats.has.parents"), share: ov.completeness.parents },
              { key: "source", label: t("stats.has.source"), share: ov.completeness.source },
            ], true, true))}
          </>
        )}

        {names && (
          <>
            {card("surnames", t("stats.surnamesTitle"), null, ranked("surnames", t("stats.surname"), names.surnames, 20))}
            {scope.sex !== "F" && card("givenMale", t("stats.givenMaleTitle"), null, ranked("givenMale", t("stats.givenName"), names.givenMale, 20, "male"))}
            {scope.sex !== "M" && card("givenFemale", t("stats.givenFemaleTitle"), null, ranked("givenFemale", t("stats.givenName"), names.givenFemale, 20, "female"))}
            {card("byCentury", t("stats.namesByCentury"), null, centuryTable(
              "byCentury",
              t("stats.givenName"),
              [{ head: t("stats.men"), tone: "male" }, { head: t("stats.women"), tone: "female" }],
              names.byCentury.map((row) => ({ century: row.century, cells: [row.male, row.female] })),
            ), true)}
            {card("namesakes", t("stats.namesakes"), null, shares("namesakes", [
              { key: "sonFather", label: t("stats.namesake.sonFather"), share: names.namesakes.sonFather, tone: "male" },
              { key: "sonGrandfather", label: t("stats.namesake.sonGrandfather"), share: names.namesakes.sonGrandfather, tone: "male" },
              { key: "daughterMother", label: t("stats.namesake.daughterMother"), share: names.namesakes.daughterMother, tone: "female" },
              { key: "daughterGrandmother", label: t("stats.namesake.daughterGrandmother"), share: names.namesakes.daughterGrandmother, tone: "female" },
            ], false))}
            {card("givenCount", t("stats.givenCount"), null, buckets("givenCount", t("stats.givenCount"), names.givenCount))}
            {card("nameKinds", t("stats.nameKinds"), t("stats.nPeople", { count: scoped.people.length }), (() => {
              // The kinds of additional name the people carry, then the primary
              // name's gaps in the warning colour.
              const rows: { key: string; label: string; ids: string[]; status?: BarRow["status"] }[] = [
                ...names.nameKinds.types.map((b) => {
                  const label = nameTypeLabel(b.label!, t);
                  return { key: `type:${b.key}`, label: label.charAt(0).toUpperCase() + label.slice(1), ids: b.ids };
                }),
                { key: "noGiven", label: t("stats.name.noGiven"), ids: names.nameKinds.noGiven, status: "fair" },
                { key: "noSurname", label: t("stats.name.noSurname"), ids: names.nameKinds.noSurname, status: "fair" },
              ];
              return withCsv(
                "nameKinds",
                () => [[t("stats.nameKinds"), t("stats.csv.count")], ...rows.map((r) => [r.label, r.ids.length])],
                <BarList
                  picked={pickedIn("nameKinds")}
                  rows={rows.map((r) => ({ key: r.key, label: r.label, value: r.ids.length, display: num(r.ids.length), count: r.ids.length, status: r.status }))}
                  onPick={(key) => {
                    const r = rows.find((x) => x.key === key)!;
                    choose("nameKinds", key, `${t("stats.nameKinds")} — ${r.label}`, r.ids);
                  }}
                />,
              );
            })())}
          </>
        )}

        {life && (
          <>
            <section className="stats-card wide stats-tiles">
              {life.all && <StatTile label={t("stats.meanAgeAtDeath")} value={dec(life.all.value)} />}
              {life.male && <StatTile tone="male" label={t("stats.meanAgeMen")} value={dec(life.male.value)} />}
              {life.female && <StatTile tone="female" label={t("stats.meanAgeWomen")} value={dec(life.female.value)} />}
            </section>
            {card("ageAtDeath", t("stats.ageAtDeath"), null, buckets("ageAtDeath", t("stats.ageAtDeath"), life.ageAtDeath), true)}
            {scope.sex !== "F" && card("ageAtDeathMale", t("stats.ageAtDeathMale"), t("stats.nPeople", { count: total(life.ageAtDeathMale) }), buckets("ageAtDeathMale", t("stats.ageAtDeathMale"), life.ageAtDeathMale, { tone: "male", labelEvery: 2, label: lowerBound, tipLabel: rangeLabel }))}
            {scope.sex !== "M" && card("ageAtDeathFemale", t("stats.ageAtDeathFemale"), t("stats.nPeople", { count: total(life.ageAtDeathFemale) }), buckets("ageAtDeathFemale", t("stats.ageAtDeathFemale"), life.ageAtDeathFemale, { tone: "female", labelEvery: 2, label: lowerBound, tipLabel: rangeLabel }))}
            {card("lifeByCentury", t("stats.lifeByCentury"), null, centuries("lifeByCentury", t("stats.lifeByCentury"), life.byCentury, dec))}
            {scope.sex !== "F" && card("lifeByCenturyMale", t("stats.lifeByCenturyMale"), null, centuries("lifeByCenturyMale", t("stats.lifeByCenturyMale"), life.byCenturyMale, dec, { tone: "male" }))}
            {scope.sex !== "M" && card("lifeByCenturyFemale", t("stats.lifeByCenturyFemale"), null, centuries("lifeByCenturyFemale", t("stats.lifeByCenturyFemale"), life.byCenturyFemale, dec, { tone: "female" }))}
            {card("oldest", t("stats.oldestList"), null, (
              <ol className="stats-oldest">
                {life.oldest.map((o) => (
                  <li key={o.id}>
                    <NameLink dataset={dataset} id={o.id} onNavigate={onNavigate} />
                    <span className="muted stats-oldest-age">{t("stats.years", { count: o.age })}</span>
                  </li>
                ))}
              </ol>
            ))}
            {card("lifeAdults", t("stats.lifeAdults", { age: CHILD_AGE }), null, centuries("lifeAdults", t("stats.lifeAdults", { age: CHILD_AGE }), life.byCenturyAdults, dec))}
            {card("childDeaths", t("stats.childDeaths", { age: CHILD_AGE }), null, centuries("childDeaths", t("stats.childDeaths", { age: CHILD_AGE }), life.childDeaths, (v) => pct(v, 100)))}
            {card("childSurvival", t("stats.childSurvival"), null, (() => {
              const names: [string, string] = [t("stats.childGrown", { age: ADULT_AGE }), t("stats.childDiedYoung", { age: ADULT_AGE })];
              return withCsv(
                "childSurvival",
                () => [[t("stats.centuryCol"), ...names, t("stats.childSurvived", { age: ADULT_AGE }), t("stats.csv.counted")], ...life.childSurvival.map((p) => [`${p.century}–${p.century + 99}`, Math.round(p.grown * 10) / 10, Math.round(p.died * 10) / 10, pct(p.grownIds.length, p.grownIds.length + p.diedIds.length), p.n])],
                <StackedColumnChart
                  names={names}
                  picked={pickedIn("childSurvival")}
                  columns={life.childSurvival.map<StackedColumn>((p) => {
                    const part = (name: string, v: number, ids: string[]) => ({
                      value: v,
                      tip: t("stats.centuryTip", { from: p.century, to: p.century + 99, value: `${name} ${dec(v)}`, n: num(p.n) }),
                      count: ids.length,
                    });
                    return {
                      key: String(p.century),
                      label: centuryLabel(p.century),
                      lower: part(names[0], p.grown, p.grownIds),
                      upper: part(names[1], p.died, p.diedIds),
                      top: p.grownIds.length + p.diedIds.length ? pct(p.grownIds.length, p.grownIds.length + p.diedIds.length) : undefined,
                    };
                  })}
                  onPick={(key, which) => {
                    const p = life.childSurvival.find((x) => String(x.century) === key)!;
                    choose("childSurvival", `${key}:${which}`, `${names[which === "lower" ? 0 : 1]} — ${centuryLabel(p.century)}`, which === "lower" ? p.grownIds : p.diedIds);
                  }}
                />,
              );
            })())}
          </>
        )}

        {fams && (
          <>
            <section className="stats-card wide stats-tiles">
              {fams.firstMarriageMaleMean && <StatTile tone="male" label={t("stats.meanMarriageMen")} value={dec(fams.firstMarriageMaleMean.value)} sub={t("stats.nPeople", { count: fams.firstMarriageMaleMean.n })} />}
              {fams.firstMarriageFemaleMean && <StatTile tone="female" label={t("stats.meanMarriageWomen")} value={dec(fams.firstMarriageFemaleMean.value)} sub={t("stats.nPeople", { count: fams.firstMarriageFemaleMean.n })} />}
              <StatTile label={t("stats.families")} value={num(families)} />
              {fams.childrenMean && <StatTile label={t("stats.childrenPerFamily")} value={dec(fams.childrenMean.value)} />}
              <StatTile label={t("stats.childless")} value={num(fams.children[0].count)} sub={pct(fams.children[0].count, families)} onClick={() => choose("famTiles", "childless", t("stats.childless"), fams.children[0].ids, true)} picked={pickedIn("famTiles") === "childless"} />
              {fams.mostUnions && fams.mostUnions.count > 1 && (
                <StatTile label={t("stats.mostUnions")} value={t("stats.unions", { count: fams.mostUnions.count })} sub={<NameLink dataset={dataset} id={fams.mostUnions.id} onNavigate={onNavigate} />} />
              )}
              {related && (
                <StatTile label={t("stats.marriedRelatives")} value={num(relatedIds.length)} sub={pct(relatedIds.length, related.of)} onClick={relatedIds.length ? () => choose("famTiles", "related", t("stats.marriedRelatives"), relatedIds, true) : undefined} picked={pickedIn("famTiles") === "related"} />
              )}
              {pick?.card === "famTiles" && (
                <PickList key={`famTiles:${pick.key}`} pick={pick} dataset={dataset} fileName={fileName} onNavigate={onNavigate} onClose={() => setPick(null)} onRelate={pick.key === "related" ? onOpenRelationship : undefined} />
              )}
            </section>
            {card("marriageDecade", t("stats.marriagesOverTime"), t("stats.nFamilies", { count: total(fams.marriagesPerPeriod) }), (() => {
              // A remarriage: a spouse married before, by an earlier dated union.
              const byId = new Map(scoped.families.map((f) => [f.id, f]));
              const again = (id: string) => {
                const f = byId.get(id);
                return !!f && ((!!f.husband && !f.husbandFirst) || (!!f.wife && !f.wifeFirst));
              };
              return stackedPeriods("marriageDecade", t("stats.marriagesOverTime"), fams.marriagesPerPeriod, [t("stats.firstMarriages"), t("stats.remarriages")],
                (ids) => [ids.filter((id) => !again(id)), ids.filter(again)], { tones: ["accent", "minor"], families: true });
            })(), true)}
            {scope.sex !== "F" && card("marriageMen", t("stats.firstMarriageMen"), t("stats.nPeople", { count: total(fams.firstMarriageMale) }), buckets("marriageMen", t("stats.firstMarriageMen"), fams.firstMarriageMale, { tone: "male" }))}
            {scope.sex !== "M" && card("marriageWomen", t("stats.firstMarriageWomen"), t("stats.nPeople", { count: total(fams.firstMarriageFemale) }), buckets("marriageWomen", t("stats.firstMarriageWomen"), fams.firstMarriageFemale, { tone: "female" }))}
            {card("ageGap", t("stats.ageGap"), t("stats.ageGapNote", { count: total(fams.ageGap) }), buckets("ageGap", t("stats.ageGap"), fams.ageGap, { families: true, label: lowerBound, tipLabel: rangeLabel }))}
            {card("marriagePlaces", t("stats.marriagePlaces"), t("stats.nFamilies", { count: total(fams.marriagePlaces) }), ranked("marriagePlaces", t("stats.marriagePlaces"), fams.marriagePlaces, 15, undefined, true, true))}
            {card("marriageMonth", t("stats.marriageMonth"), t("stats.nFamilies", { count: total(fams.marriageMonth) }), buckets("marriageMonth", t("stats.marriageMonth"), fams.marriageMonth, { families: true, label: monthLabel }))}
            {card("children", t("stats.childrenPerFamilyChart"), t("stats.nFamilies", { count: families }), buckets("children", t("stats.childrenPerFamilyChart"), fams.children, { families: true }))}
            {card("unions", t("stats.unionsPerPerson"), t("stats.nPeople", { count: total(fams.unionsPerPerson) }), buckets("unions", t("stats.unionsPerPerson"), fams.unionsPerPerson))}
            {card("firstChild", t("stats.firstChild"), t("stats.nFamilies", { count: total(fams.firstChild) }), buckets("firstChild", t("stats.firstChild"), fams.firstChild, { families: true, label: (b) => t(`stats.firstChild.${b.key}`) }))}
            {card("childrenByCentury", t("stats.childrenByCentury"), null, centuries("childrenByCentury", t("stats.childrenByCentury"), fams.childrenByCentury, dec, { families: true }))}
            {related && card("relatedCouples", t("stats.relatedCouples"), t("stats.nFamilies", { count: related.of }), (
              <BarList
                picked={pickedIn("relatedCouples")}
                rows={COUPLE_KINSHIP.map((k) => ({ key: k, label: t(`stats.kin.${k}`), value: related.byKind[k].length, display: num(related.byKind[k].length), count: related.byKind[k].length }))}
                onPick={(key) => choose("relatedCouples", key, `${t("stats.relatedCouples")} — ${t(`stats.kin.${key}`)}`, related.byKind[key as CoupleKinship], true)}
              />
            ))}
            {card("motherFirst", t("stats.motherFirst"), t("stats.nFamilies", { count: total(fams.motherFirst) }), buckets("motherFirst", t("stats.motherFirst"), fams.motherFirst, { families: true, tone: "female" }))}
            {card("motherLast", t("stats.motherLast"), t("stats.nFamilies", { count: total(fams.motherLast) }), buckets("motherLast", t("stats.motherLast"), fams.motherLast, { families: true, tone: "female" }))}
          </>
        )}

        {births && (
          <>
            <section className="stats-card wide stats-tiles">
              <StatTile label={t("stats.twins")} value={num(births.twins.sets)} sub={t("stats.nFamilies", { count: births.twins.families.length })} onClick={births.twins.sets ? () => choose("birthTiles", "twins", t("stats.twins"), births.twins.families, true) : undefined} picked={pickedIn("birthTiles") === "twins"} />
              {births.multiples.sets > 0 && (
                <StatTile label={t("stats.multiples")} value={num(births.multiples.sets)} sub={t("stats.nFamilies", { count: births.multiples.families.length })} onClick={() => choose("birthTiles", "multiples", t("stats.multiples"), births.multiples.families, true)} picked={pickedIn("birthTiles") === "multiples"} />
              )}
              {births.baptismMean && <StatTile label={t("stats.baptismMean")} value={dec(births.baptismMean.value)} sub={t("stats.nPeople", { count: births.baptismMean.n })} />}
              {pick?.card === "birthTiles" && (
                <PickList key={`birthTiles:${pick.key}`} pick={pick} dataset={dataset} fileName={fileName} onNavigate={onNavigate} onClose={() => setPick(null)} />
              )}
            </section>
            {card("birthDecade", t("stats.birthsOverTime"), null, stackedPeriods("birthDecade", t("stats.birthsOverTime"), births.perPeriod, [t("stats.men"), t("stats.women")], bySex, { tones: ["male", "female"] }), true)}
            {card("birthPlaces", t("stats.birthPlaces"), null, ranked("birthPlaces", t("stats.birthPlaces"), births.places, 15, undefined, true))}
            {card("birthMonth", t("stats.birthsByMonth"), null, buckets("birthMonth", t("stats.birthsByMonth"), births.byMonth, { label: monthLabel }))}
            {card("baptism", t("stats.baptism"), t("stats.nPeople", { count: total(births.baptism) }), buckets("baptism", t("stats.baptism"), births.baptism, { label: (b) => t(`stats.baptism.${b.key}`) }))}
          </>
        )}

        {deaths && (
          <>
            {card("deathDecade", t("stats.deathsOverTime"), null, stackedPeriods("deathDecade", t("stats.deathsOverTime"), deaths.perPeriod, [t("stats.men"), t("stats.women")], bySex, { tones: ["male", "female"] }), true)}
            {card("deathPlaces", t("stats.deathPlaces"), null, ranked("deathPlaces", t("stats.deathPlaces"), deaths.places, 15, undefined, true))}
            {card("causes", t("stats.causes"), null, ranked("causes", t("stats.causes"), deaths.causes, 15))}
            {card("causeAge", t("stats.causeAge"), null, (
              <BarList
                limit={listLimit("causeAge", deaths.ageByCause.length, 15)}
                picked={pickedIn("causeAge")}
                rows={deaths.ageByCause.map((c) => ({ key: c.key, label: c.label, value: c.value, display: dec(c.value), count: c.ids.length, tip: t("stats.nPeople", { count: c.ids.length }) }))}
                onPick={(key) => {
                  const c = deaths.ageByCause.find((x) => x.key === key)!;
                  choose("causeAge", key, `${t("stats.causeAge")} — ${c.label}`, c.ids);
                }}
              />
            ))}
            {card("deathMonth", t("stats.deathsByMonth"), null, buckets("deathMonth", t("stats.deathsByMonth"), deaths.byMonth, { label: monthLabel }))}
          </>
        )}

        {jobs && (
          <>
            <section className="stats-card wide stats-tiles">
              <StatTile label={t("stats.distinctOccupations")} value={num(jobs.occupations.length)} />
              <StatTile label={t("stats.withOccupation")} value={num(jobs.withOccupation.n)} sub={pct(jobs.withOccupation.n, jobs.withOccupation.of)} onClick={() => choose("jobTiles", "with", t("stats.withOccupation"), jobs.withOccupation.ids)} picked={pickedIn("jobTiles") === "with"} />
              {jobs.withEducation.n > 0 && (
                <StatTile label={t("stats.withEducation")} value={num(jobs.withEducation.n)} sub={pct(jobs.withEducation.n, jobs.withEducation.of)} onClick={() => choose("jobTiles", "edu", t("stats.withEducation"), jobs.withEducation.ids)} picked={pickedIn("jobTiles") === "edu"} />
              )}
              {pick?.card === "jobTiles" && (
                <PickList key={`jobTiles:${pick.key}`} pick={pick} dataset={dataset} fileName={fileName} onNavigate={onNavigate} onClose={() => setPick(null)} />
              )}
            </section>
            {card("occupations", t("stats.occupations"), null, ranked("occupations", t("stats.occupation"), jobs.occupations, 20))}
            {jobs.education.length > 0 && card("education", t("stats.education"), null, ranked("education", t("stats.education"), jobs.education, 20))}
            {card("jobsByCentury", t("stats.occupationsByCentury"), null, centuryTable(
              "jobsByCentury",
              t("stats.occupation"),
              [{ head: t("stats.occupations") }],
              jobs.byCentury.map((row) => ({ century: row.century, cells: [row.top] })),
            ), true)}
          </>
        )}

        {moves && (
          <>
            <section className="stats-card wide stats-tiles">
              {moves.distanceMean && <StatTile label={t("stats.meanDistance")} value={t("stats.km", { value: num(Math.round(moves.distanceMean.value)) })} sub={t("stats.nPeople", { count: moves.distanceMean.n })} />}
              <StatTile label={t("stats.emigrants")} value={num(moves.emigrants.n)} sub={pct(moves.emigrants.n, moves.emigrants.of)} onClick={moves.emigrants.n ? () => choose("moveTiles", "emigrants", t("stats.emigrants"), moves.emigrants.ids) : undefined} picked={pickedIn("moveTiles") === "emigrants"} />
              <StatTile label={t("stats.samePlaceCouples")} value={num(moves.samePlaceCouples.n)} sub={pct(moves.samePlaceCouples.n, moves.samePlaceCouples.of)} onClick={moves.samePlaceCouples.n ? () => choose("moveTiles", "samePlace", t("stats.samePlaceCouples"), moves.samePlaceCouples.ids, true) : undefined} picked={pickedIn("moveTiles") === "samePlace"} />
              {pick?.card === "moveTiles" && (
                <PickList key={`moveTiles:${pick.key}`} pick={pick} dataset={dataset} fileName={fileName} onNavigate={onNavigate} onClose={() => setPick(null)} />
              )}
            </section>
            {!moves.distanceMean && <p className="muted stats-empty stats-note">{t("stats.noDistances")}</p>}
            {moves.distanceMean && card("distance", t("stats.distance"), t("stats.nPeople", { count: total(moves.distance) }), buckets("distance", t("stats.distance"), moves.distance, { label: distanceLabel }))}
            {moves.distanceMean && card("distanceByCentury", t("stats.meanDistance"), null, centuries("distanceByCentury", t("stats.meanDistance"), moves.distanceByCentury, (v) => t("stats.km", { value: num(Math.round(v)) })))}
            {card("countryMoves", t("stats.countryMoves"), t("stats.nPeople", { count: moves.emigrants.n }), (
              <BarList
                limit={listLimit("countryMoves", moves.countryMoves.length, 15)}
                picked={pickedIn("countryMoves")}
                rows={moves.countryMoves.map((b) => {
                  // From above, to below: two country names side by side never fit a label.
                  const [from, to] = b.key.split(">");
                  const country = (code: string) => (
                    <span>
                      {/^[a-z]{2}$/.test(code) && <span className="stats-flag">{flagEmoji(code)} </span>}
                      {code ? countryFacetName(code, lang) : t("tools.geocode.countryUnknown")}
                    </span>
                  );
                  const label = <span className="stats-move">{country(from)}<span>→ {country(to)}</span></span>;
                  return { key: b.key, label, tip: countryMove(b.key), value: b.count, display: num(b.count), count: b.count };
                })}
                onPick={(key) => {
                  const b = moves.countryMoves.find((x) => x.key === key)!;
                  choose("countryMoves", key, `${t("stats.countryMoves")} — ${countryMove(key)}`, b.ids);
                }}
              />
            ))}
          </>
        )}

        {page === "generations" && !lineage && (
          <p className="tools-clean">{t("stats.lineagePick")}</p>
        )}
        {lineage && (
          <>
            <section className="stats-card wide stats-tiles">
              <StatTile label={t("stats.distinctAncestors")} value={num(lineage.distinctAncestors)} />
              <StatTile label={t("stats.livingAncestors")} value={num(lineage.livingAncestors.length)} onClick={lineage.livingAncestors.length ? () => choose("genTiles", "livingAnc", t("stats.livingAncestors"), lineage.livingAncestors) : undefined} picked={pickedIn("genTiles") === "livingAnc"} />
              <StatTile label={t("stats.generationsDeep")} value={num(lineage.ancestors.length)} />
              {lineage.implex > 0 && <StatTile label={t("stats.implex")} value={pct(lineage.implex, 1)} />}
              <StatTile label={t("stats.descendantsCount")} value={num(lineage.descendantIds.length)} onClick={lineage.descendantIds.length ? () => choose("genTiles", "desc", t("stats.descendantsCount"), lineage.descendantIds) : undefined} picked={pickedIn("genTiles") === "desc"} />
              <StatTile label={t("stats.livingDescendants")} value={num(lineage.livingDescendants.length)} onClick={lineage.livingDescendants.length ? () => choose("genTiles", "living", t("stats.livingDescendants"), lineage.livingDescendants) : undefined} picked={pickedIn("genTiles") === "living"} />
              {pick?.card === "genTiles" && (
                <PickList key={`genTiles:${pick.key}`} pick={pick} dataset={dataset} fileName={fileName} onNavigate={onNavigate} onClose={() => setPick(null)} />
              )}
            </section>
            {lineage.ancestors.length > 0 && card("ancestorsGen", t("stats.ancestorsByGen"), null, (
              <BarList
                max={100}
                limit={listLimit("ancestorsGen", lineage.ancestors.length, 12)}
                labelWidth="2.5em"
                picked={pickedIn("ancestorsGen")}
                rows={lineage.ancestors.map((g) => ({
                  key: String(g.gen),
                  label: String(g.gen),
                  value: (100 * g.filled) / g.slots,
                  display: pct(g.filled, g.slots),
                  tip: t("stats.shareTip", { n: num(g.filled), of: num(g.slots) }),
                  count: g.ids.length,
                  status: gradeOf(g.filled / g.slots),
                }))}
                onPick={(key) => {
                  const g = lineage.ancestors.find((x) => String(x.gen) === key)!;
                  choose("ancestorsGen", key, `${t("stats.ancestorsByGen")} — ${t("stats.genLabel", { n: g.gen })}`, g.ids);
                }}
              />
            ))}
            {lineage.ancestors.length > 1 && card("ancestorsSide", t("stats.ancestorsBySide"), null, (
              <PairBarList
                names={[t("stats.side.paternal"), t("stats.side.maternal")]}
                picked={pickedIn("ancestorsSide")}
                limit={listLimit("ancestorsSide", lineage.ancestors.length, 12)}
                labelWidth="2.5em"
                rows={lineage.ancestors.map<PairRow>((g) => {
                  const half = g.slots / 2;
                  const of = (side: { filled: number; ids: string[] }) => ({
                    value: (100 * side.filled) / half,
                    display: pct(side.filled, half),
                    tip: t("stats.shareTip", { n: num(side.filled), of: num(half) }),
                    count: side.ids.length,
                  });
                  return { key: String(g.gen), label: String(g.gen), a: of(g.paternal), b: of(g.maternal) };
                })}
                onPick={(key, side) => {
                  const g = lineage.ancestors.find((x) => String(x.gen) === key)!;
                  choose("ancestorsSide", `${key}:${side}`, `${t(side === "a" ? "stats.side.paternal" : "stats.side.maternal")} — ${t("stats.genLabel", { n: g.gen })}`, (side === "a" ? g.paternal : g.maternal).ids);
                }}
              />
            ))}
            {lineage.ancestors.length > 0 && card("childrenByGen", t("stats.childrenByGen"), null, withCsv(
              "childrenByGen",
              () => [[t("stats.csv.generation"), t("stats.childrenByGen"), t("stats.csv.counted")], ...lineage.ancestors.map((g) => [g.gen, Math.round(g.childrenMean * 10) / 10, g.ids.length])],
              <BarList
                limit={listLimit("childrenByGen", lineage.ancestors.length, 12)}
                labelWidth="2.5em"
                picked={pickedIn("childrenByGen")}
                rows={lineage.ancestors.map((g) => ({
                  key: String(g.gen),
                  label: String(g.gen),
                  value: g.childrenMean,
                  display: dec(g.childrenMean),
                  tip: t("stats.nPeople", { count: g.ids.length }),
                  count: g.ids.length,
                }))}
                onPick={(key) => {
                  const g = lineage.ancestors.find((x) => String(x.gen) === key)!;
                  choose("childrenByGen", key, `${t("stats.childrenByGen")} — ${t("stats.genLabel", { n: g.gen })}`, g.ids);
                }}
              />,
            ))}
            {lineage.descendants.length > 0 && card("descendantsGen", t("stats.descendantsByGen"), null, (() => {
              // Men below, women above, the generation's whole count on top
              // (people of unknown sex are in that count only).
              const names: [string, string] = [t("stats.men"), t("stats.women")];
              const gens = lineage.descendants.map((g) => ({
                gen: g.gen,
                all: g.ids,
                men: g.ids.filter((id) => dataset.individuals.get(id)?.sex === "M"),
                women: g.ids.filter((id) => dataset.individuals.get(id)?.sex === "F"),
              }));
              const part = (gen: number, name: string, ids: string[]) => ({
                value: ids.length,
                tip: `${t("stats.genLabel", { n: gen })} — ${name}: ${num(ids.length)}`,
                count: ids.length,
              });
              return (
                <StackedColumnChart
                  names={names}
                  tones={["male", "female"]}
                  picked={pickedIn("descendantsGen")}
                  columns={gens.map<StackedColumn>((g) => ({
                    key: String(g.gen),
                    label: String(g.gen),
                    lower: part(g.gen, names[0], g.men),
                    upper: part(g.gen, names[1], g.women),
                    top: num(g.all.length),
                  }))}
                  onPick={(key, which) => {
                    const g = gens.find((x) => String(x.gen) === key)!;
                    choose("descendantsGen", `${key}:${which}`, `${t("stats.descendantsByGen")} — ${t("stats.genLabel", { n: g.gen })} — ${names[which === "lower" ? 0 : 1]}`, which === "lower" ? g.men : g.women);
                  }}
                />
              );
            })())}
            {!lineage.ancestors.length && !lineage.descendants.length && (
              <p className="tools-clean">{t("stats.noLineage")}</p>
            )}
            {lineage.repeated.length > 0 && card("repeatedAncestors", t("stats.repeatedAncestors"), null, (
              <ul className="stats-walls stats-walls-plain">
                {lineage.repeated.slice(0, listLimit("repeatedAncestors", lineage.repeated.length, 12)).map((r) => (
                  <li key={r.id}>
                    <NameLink dataset={dataset} id={r.id} onNavigate={onNavigate} />
                    <span className="muted stats-walls-missing" {...tipProps(t("stats.repeatedTip", { count: r.count }))}>{gensLabel(r.gens)}</span>
                  </li>
                ))}
              </ul>
            ))}
            {lineage.walls.length > 0 && card("walls", t("stats.walls"), t("stats.nPeople", { count: lineage.walls.length }), (
              <ul className="stats-walls">
                {lineage.walls.slice(0, listLimit("walls", lineage.walls.length, 12)).map((w) => (
                  <li key={w.id}>
                    <span className="muted stats-walls-gen">{w.gen}</span>
                    <NameLink dataset={dataset} id={w.id} onNavigate={onNavigate} />
                    <span className="muted stats-walls-missing">{t(w.father && w.mother ? "stats.wall.both" : w.father ? "stats.wall.father" : "stats.wall.mother")}</span>
                  </li>
                ))}
              </ul>
            ))}
          </>
        )}

        {research && (
          <>
            <section className="stats-card wide stats-tiles">
              <StatTile label={t("stats.sourcedEvents")} value={pct(research.sourcedEvents, research.events)} sub={t("stats.shareTip", { n: num(research.sourcedEvents), of: num(research.events) })} />
              {research.citationsMean && <StatTile label={t("stats.citationsMean")} value={dec(research.citationsMean.value)} />}
              <StatTile label={t("stats.noEvents")} value={num(research.noEvents.length)} sub={pct(research.noEvents.length, people)} onClick={research.noEvents.length ? () => choose("researchTiles", "noEvents", t("stats.noEvents"), research.noEvents) : undefined} picked={pickedIn("researchTiles") === "noEvents"} />
              {pick?.card === "researchTiles" && (
                <PickList key={`researchTiles:${pick.key}`} pick={pick} dataset={dataset} fileName={fileName} onNavigate={onNavigate} onClose={() => setPick(null)} />
              )}
            </section>
            {card("sourcedByTag", t("stats.sourcedByTag"), null, (
              <BarList
                max={100}
                picked={pickedIn("sourcedByTag")}
                rows={research.byTag.map((s) => ({
                  key: s.key,
                  label: tagLabel(s),
                  value: (100 * s.sourced) / s.events,
                  display: pct(s.sourced, s.events),
                  tip: t("stats.shareTip", { n: num(s.sourced), of: num(s.events) }),
                  count: s.missing.length,
                  status: gradeOf(s.sourced / s.events),
                }))}
                onPick={(key) => {
                  const s = research.byTag.find((x) => x.key === key)!;
                  choose("sourcedByTag", key, t("stats.missingTitle", { what: tagLabel(s) }), s.missing, s.families);
                }}
              />
            ))}
            {researchBySide && card("sourcedBySide", t("stats.sourcedBySide"), null, (
              <PairBarList
                names={[t("stats.side.paternal"), t("stats.side.maternal")]}
                picked={pickedIn("sourcedBySide")}
                rows={research.byTag.map<PairRow>((tag) => {
                  const of = (stats: typeof research) => {
                    const s = stats.byTag.find((x) => x.key === tag.key);
                    return s && s.events ? { value: (100 * s.sourced) / s.events, display: pct(s.sourced, s.events), tip: t("stats.shareTip", { n: num(s.sourced), of: num(s.events) }), count: s.missing.length } : undefined;
                  };
                  return { key: tag.key, label: tagLabel(tag), a: of(researchBySide.paternal), b: of(researchBySide.maternal) };
                })}
                onPick={(key, side) => {
                  const s = (side === "a" ? researchBySide.paternal : researchBySide.maternal).byTag.find((x) => x.key === key)!;
                  choose("sourcedBySide", `${key}:${side}`, `${t(side === "a" ? "stats.side.paternal" : "stats.side.maternal")} — ${t("stats.missingTitle", { what: tagLabel(s) })}`, s.missing, s.families);
                }}
              />
            ))}
            {card("citations", t("stats.citations"), t("stats.nPeople", { count: people }), buckets("citations", t("stats.citations"), research.citations))}
          </>
        )}
      </div>
      )}
    </div>
  );
}

/** A birth-year bound; blank for none. */
function YearInput({ value, onChange, label }: { value?: number; onChange: (v: number | undefined) => void; label: string }) {
  return (
    <input
      type="number"
      className="tools-search-input stats-year"
      aria-label={label}
      placeholder={label}
      value={value ?? ""}
      onChange={(e) => {
        const v = e.target.value.trim();
        onChange(v === "" || !Number.isFinite(Number(v)) ? undefined : Math.trunc(Number(v)));
      }}
    />
  );
}

/** The people (or couples) behind a picked bar, each opening in Edit. */
function PickList({ pick, dataset, fileName, onNavigate, onClose, onRelate }: {
  pick: Pick;
  dataset: Dataset;
  fileName: string;
  onNavigate: (id: string) => void;
  onClose: () => void;
  onRelate?: (fromId: string, toId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const nameOf = useNameOf();
  // The whole list, windowed: a bar can stand for half a million people, and
  // only the rows in the scroll box are ever mounted.
  const virtual = useVirtualList({ count: pick.ids.length, estimate: 34, itemsKey: pick.ids });
  /** The listed people (or couples) as a table: record id, name, years. */
  const download = () => {
    const person = (id: string | undefined) => {
      const indi = id ? dataset.individuals.get(id) : undefined;
      return indi ? [nameOf(indi), lifespanOf(indi)] : ["", ""];
    };
    const rows: (string | number)[][] = pick.families
      ? [[t("stats.csv.id"), t("stats.csv.husband"), t("stats.csv.years"), t("stats.csv.wife"), t("stats.csv.years")],
        ...pick.ids.map((id) => {
          const fam = dataset.families.get(id);
          return [id, ...person(fam?.husband), ...person(fam?.wife)];
        })]
      : [[t("stats.csv.id"), t("stats.csv.person"), t("stats.csv.years")], ...pick.ids.map((id) => [id, ...person(id)])];
    downloadText(savedName(fileName, "list.csv"), toCsv(rows, csvStyleFor(i18n.language)), "text/csv;charset=utf-8");
  };
  return (
    <div className="stats-pick">
      <div className="stats-pick-head">
        <strong>{pick.title}</strong>
        <span className="muted">{pick.families ? t("stats.nFamilies", { count: pick.ids.length }) : t("stats.nPeople", { count: pick.ids.length })}</span>
        <span className="stats-pick-tools">
          <button type="button" className="stats-info" onClick={download} {...tipProps(t("stats.downloadList"))}>
            <DownloadIcon size={14} />
          </button>
          <button type="button" className="tools-issue-link stats-pick-close" onClick={onClose} aria-label={t("stats.closeList")}>✕</button>
        </span>
      </div>
      <ul className="tools-issues">
        <li className="v-spacer" style={{ height: virtual.padTop }} ref={virtual.topRef} aria-hidden />
        {pick.ids.slice(virtual.start, virtual.end).map((id, k) => {
          const i = virtual.start + k;
          return (
            <li key={id} className={`tools-issue${i % 2 ? " zebra" : ""}`}>
              {pick.families ? <Couple dataset={dataset} id={id} onNavigate={onNavigate} onRelate={onRelate} /> : <PersonLink dataset={dataset} id={id} fallback={id} onNavigate={onNavigate} />}
            </li>
          );
        })}
        <li className="v-spacer" style={{ height: virtual.padBottom }} ref={virtual.bottomRef} aria-hidden />
      </ul>
    </div>
  );
}

/** A family as its couple — the spouses it names, or the record itself when it names none. */
function Couple({ dataset, id, onNavigate, nameOnly = false, onRelate }: {
  dataset: Dataset;
  id: string;
  onNavigate: (id: string) => void;
  nameOnly?: boolean;
  /** Offer the diagram of how the two spouses are related. */
  onRelate?: (fromId: string, toId: string) => void;
}) {
  const { t } = useTranslation();
  const fam = dataset.families.get(id);
  const spouses = [fam?.husband, fam?.wife].filter((s): s is string => !!s);
  if (!spouses.length) return <PersonLink dataset={dataset} id={id} fallback={id} onNavigate={onNavigate} />;
  return (
    <span className="stats-couple">
      {spouses.map((s, i) => (
        <span key={s}>
          {i > 0 && <span className="muted"> ⚭ </span>}
          {nameOnly
            ? <NameLink dataset={dataset} id={s} onNavigate={onNavigate} />
            : <PersonLink dataset={dataset} id={s} fallback={s} onNavigate={onNavigate} />}
        </span>
      ))}
      {onRelate && spouses.length === 2 && (
        <button type="button" className="stats-info stats-relate" onClick={() => onRelate(spouses[0], spouses[1])} {...tipProps(t("stats.showRelationship"))}>
          <ChartIcon size={18} />
        </button>
      )}
    </span>
  );
}

/** A person by name alone, for a tile: the years would only crowd it, and the
 *  click opens the person anyway. */
function NameLink({ dataset, id, onNavigate }: { dataset: Dataset; id: string; onNavigate: (id: string) => void }) {
  const nameOf = useNameOf();
  const indi = dataset.individuals.get(id);
  return (
    <button type="button" className="tools-issue-link person-ref" onClick={() => onNavigate(id)}>
      <span className={`person-name ${sexClass(indi?.sex)}`}>{indi ? nameOf(indi) : id}</span>
    </button>
  );
}
