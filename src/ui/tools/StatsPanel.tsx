import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import { computeKinship } from "../../tools/batch";
import { buildStatsFacts } from "../../stats/facts";
import { applyCountry, DEFAULT_SCOPE, scopeFacts, type StatsScope, type StatsWho } from "../../stats/scope";
import {
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
import { birthStats, CAUSE_AGE_MIN, deathStats, occupationStats } from "../../stats/vitals";
import { tipProps } from "../IconTip";
import { InfoIcon } from "../icons/InfoIcon";
import { useHomeCountry } from "../DatasetDerivations";
import { PersonLink } from "../PersonLink";
import { StartPersonSelector } from "../StartPersonSelector";
import { useNameOf } from "../SettingsContext";
import { sexClass } from "../sex";
import { useVirtualList } from "../useVirtualList";
import { Segmented } from "../Segmented";
import { CountryChips, type CountryChip } from "./CountryChips";
import { countryFacetLabel } from "../../geo/placeCountry";
import { ToolsLoading } from "./shared";
import { ToolSummary } from "./ToolSummary";
import { BarList, ColumnChart, StatTile, toneClass, type BarRow, type Column, type Tone } from "./StatsCharts";
import type { ToolView } from "../ToolsView";

/** The statistics pages; the overview is the tool's front page. */
const PAGES = ["tree", "names", "lifespan", "families", "births", "deaths", "occupations"] as const;
type Page = (typeof PAGES)[number];
const WHO: StatsWho[] = ["all", "blood", "ancestors", "descendants"];

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

/** A place by its two ends — the named place and its country — when it has levels between. */
function shortPlace(value: string): string {
  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length > 2 ? `${parts[0]}, ${parts[parts.length - 1]}` : value;
}

/** Cards that share another card's explanation: the overview's top five are the names page's lists. */
const ABOUT_ALIAS: Record<string, string> = { topSurnames: "surnames", topMale: "givenMale", topFemale: "givenFemale", topBirthPlaces: "birthPlaces" };

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

export function StatsPanel({
  dataset,
  editVersion,
  onNavigate,
  active,
  startId,
  view,
  onViewChange,
}: {
  dataset: Dataset;
  editVersion: number;
  onNavigate: (id: string) => void;
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
  const [ready, setReady] = useState(false);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- seenVersion: the dataset is mutated in place
  const facts = useMemo(() => (ready ? buildStatsFacts(dataset, home) : undefined), [ready, dataset, seenVersion, home]);
  const lined = scope.who !== "all";
  // Whose line the statistics follow: the app's start person until another is
  // picked here. The choice is the statistics' own and moves nothing else.
  const [ownStart, setOwnStart] = useState<string | undefined>();
  const statsStart = ownStart && dataset.individuals.has(ownStart) ? ownStart : startId;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- seenVersion: the dataset is mutated in place
  const kinship = useMemo(() => (lined && statsStart ? computeKinship(dataset, statsStart) : null), [lined, dataset, statsStart, seenVersion]);
  const base = useMemo(() => (facts ? scopeFacts(facts, scope, kinship, statsStart) : []), [facts, scope, kinship, statsStart]);
  const [filtersOpen, setFiltersOpen] = useState(readFiltersOpen);
  const toggleFilters = () => setFiltersOpen((open) => { writeFiltersOpen(!open); return !open; });
  const scoped = useMemo(() => (facts ? applyCountry(facts, base, scope) : undefined), [facts, base, scope]);
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
  const births = useMemo(() => (scoped && page === "births" ? birthStats(scoped) : undefined), [scoped, page]);
  const deaths = useMemo(() => (scoped && page === "deaths" ? deathStats(scoped) : undefined), [scoped, page]);
  const jobs = useMemo(() => (scoped && page === "occupations" ? occupationStats(scoped) : undefined), [scoped, page]);

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

  /** A column chart over buckets; picking a column lists its rows. */
  const buckets = (card: string, title: string, list: Bucket[], opts: { families?: boolean; tone?: Tone; label?: (b: Bucket) => string; labelEvery?: number; tipLabel?: (b: Bucket) => string } = {}) => {
    const label = opts.label ?? rangeLabel;
    // The hover text and the list's title name the bucket in full where the axis abbreviates it.
    const full = opts.tipLabel ?? label;
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
  const centuries = (card: string, title: string, points: CenturyPoint[], format: (v: number) => string, opts: { families?: boolean } = {}) => (
    <ColumnChart
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
  const ranked = (card: string, title: string, list: Bucket[], limit: number, tone?: Tone, places = false) => (
    <BarList
      limit={limit}
      tone={tone}
      picked={pickedIn(card)}
      rows={list.map((b) => ({
        key: b.key,
        // A long place reads by its two ends; the whole value is the tip.
        label: places ? shortPlace(b.label!) : b.label,
        tip: places && shortPlace(b.label!) !== b.label ? b.label : undefined,
        value: b.count,
        display: num(b.count),
        count: b.count,
      }))}
      onPick={(key) => {
        const b = list.find((x) => x.key === key)!;
        choose(card, key, `${title} — ${b.label}`, b.ids);
      }}
    />
  );

  /** Shares as percentage bars; a pick lists the rows `missing` holds when `listMissing`. */
  const shares = (card: string, items: { key: string; label: string; share: Share; tone?: Tone }[], listMissing: boolean, graded = false) => (
    <BarList
      max={100}
      picked={pickedIn(card)}
      rows={items.map<BarRow>(({ key, label, share, tone }) => ({
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
          : t("stats.click.bar");
  const card = (id: string, title: string, note: ReactNode, body: ReactNode, wide = false) => {
    // What the numbers are and how they were taken — one tip per card.
    const about = `stats.about.${ABOUT_ALIAS[id] ?? id}`;
    return (
    <section className={`stats-card${wide ? " wide" : ""}`} key={id}>
      <header className="stats-card-head">
        <h3>{title}</h3>
        {note && <span className="stats-card-note">{note}</span>}
        {i18n.exists(about) && (
          <button type="button" className="stats-info" {...tipProps([t(about), clickHint(id)].filter(Boolean).join("\n\n"), { heading: title })}>
            <InfoIcon size={14} />
          </button>
        )}
      </header>
      {body}
      {pick?.card === id && (
        <PickList key={`${pick.card}:${pick.key}`} pick={pick} dataset={dataset} onNavigate={onNavigate} onClose={() => setPick(null)} />
      )}
    </section>
  );
  };
  const total = (list: Bucket[]) => list.reduce((a, b) => a + b.count, 0);
  const monthLabel = (b: Bucket) => new Date(2000, b.lo! - 1, 1).toLocaleString(lang, { month: "short" });
  const countryName = (code: string) => (code ? countryFacetLabel(code, lang) : t("tools.geocode.countryUnknown"));
  // A signed range is too wide for a column: the axis names its lower bound, the tip the range.
  const lowerBound = (b: Bucket) => (b.lo === undefined ? rangeLabel(b) : b.hi === undefined ? `${signed(b.lo)}+` : signed(b.lo));
  const periodLabel = (b: Bucket) => String(b.lo);
  /** Label about a dozen periods however many there are. */
  const periodStep = (list: Bucket[]) => Math.max(1, Math.ceil(list.length / 12));

  /** Top names or occupations per century, as chips that list their people. */
  const centuryTable = (id: string, columns: { head: string; tone?: Tone }[], rows: { century: number; cells: Bucket[][] }[]) => (
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
          <Segmented
            label={t("stats.who")}
            value={scope.who}
            onChange={(who) => set({ who })}
            items={WHO.map((w) => ({ key: w, label: t(`stats.who.${w}`) }))}
          />
          {lined && (
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
        <div className="stats-head-end">
          <ToolSummary>{t("stats.summary", { count: facts.people.length, scoped: num(people) })}</ToolSummary>
          <button
            type="button"
            className={`tools-chip${activeFilters ? " active" : ""}`}
            aria-expanded={filtersOpen}
            onClick={toggleFilters}
          >
            {filtersOpen ? "▾" : "▸"} {t("stats.filters")}
            {activeFilters > 0 && <span className="tools-chip-count"> {activeFilters}</span>}
          </button>
        </div>
      </div>

      {filtersOpen && (
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
              {ov.oldest && (
                <StatTile label={t("stats.oldest")} value={t("stats.years", { count: ov.oldest.age })} sub={<NameLink dataset={dataset} id={ov.oldest.id} onNavigate={onNavigate} />} />
              )}
              {ov.ageAtDeath && (
                <StatTile label={t("stats.meanAgeAtDeath")} value={dec(ov.ageAtDeath.value)} />
              )}
              {ov.largestFamily && (
                <StatTile label={t("stats.largestFamily")} value={t("stats.children", { count: ov.largestFamily.children })} sub={<Couple dataset={dataset} id={ov.largestFamily.id} onNavigate={onNavigate} nameOnly />} />
              )}
              {ov.childrenPerFamily && (
                <StatTile label={t("stats.childrenPerFamily")} value={dec(ov.childrenPerFamily.value)} />
              )}
              {pick?.card === "tiles" && (
                <PickList key={`tiles:${pick.key}`} pick={pick} dataset={dataset} onNavigate={onNavigate} onClose={() => setPick(null)} />
              )}
            </section>
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
          </>
        )}

        {names && (
          <>
            {card("surnames", t("stats.surnamesTitle"), null, ranked("surnames", t("stats.surname"), names.surnames, 20))}
            {scope.sex !== "F" && card("givenMale", t("stats.givenMaleTitle"), null, ranked("givenMale", t("stats.givenName"), names.givenMale, 20, "male"))}
            {scope.sex !== "M" && card("givenFemale", t("stats.givenFemaleTitle"), null, ranked("givenFemale", t("stats.givenName"), names.givenFemale, 20, "female"))}
            {card("byCentury", t("stats.namesByCentury"), null, centuryTable(
              "byCentury",
              [{ head: t("stats.men"), tone: "male" }, { head: t("stats.women"), tone: "female" }],
              names.byCentury.map((row) => ({ century: row.century, cells: [row.male, row.female] })),
            ), true)}
            {card("givenCount", t("stats.givenCount"), null, buckets("givenCount", t("stats.givenCount"), names.givenCount))}
            {card("namesakes", t("stats.namesakes"), null, shares("namesakes", [
              { key: "sonFather", label: t("stats.namesake.sonFather"), share: names.namesakes.sonFather, tone: "male" },
              { key: "sonGrandfather", label: t("stats.namesake.sonGrandfather"), share: names.namesakes.sonGrandfather, tone: "male" },
              { key: "daughterMother", label: t("stats.namesake.daughterMother"), share: names.namesakes.daughterMother, tone: "female" },
              { key: "daughterGrandmother", label: t("stats.namesake.daughterGrandmother"), share: names.namesakes.daughterGrandmother, tone: "female" },
            ], false))}
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
            {card("lifeByCentury", t("stats.lifeByCentury"), t("stats.byBirthCentury"), centuries("lifeByCentury", t("stats.lifeByCentury"), life.byCentury, dec))}
            {card("lifeAdults", t("stats.lifeAdults", { age: CHILD_AGE }), t("stats.byBirthCentury"), centuries("lifeAdults", t("stats.lifeAdults", { age: CHILD_AGE }), life.byCenturyAdults, dec))}
            {card("childDeaths", t("stats.childDeaths", { age: CHILD_AGE }), t("stats.byBirthCentury"), centuries("childDeaths", t("stats.childDeaths", { age: CHILD_AGE }), life.childDeaths, (v) => pct(v, 100)))}
            {card("oldest", t("stats.oldestList"), null, (
              <ol className="stats-oldest">
                {life.oldest.map((o) => (
                  <li key={o.id}>
                    <PersonLink dataset={dataset} id={o.id} fallback={o.id} onNavigate={onNavigate} />
                    <span className="muted"> {t("stats.years", { count: o.age })}</span>
                  </li>
                ))}
              </ol>
            ))}
          </>
        )}

        {fams && (
          <>
            <section className="stats-card wide stats-tiles">
              {fams.firstMarriageMaleMean && <StatTile tone="male" label={t("stats.meanMarriageMen")} value={dec(fams.firstMarriageMaleMean.value)} sub={t("stats.nPeople", { count: fams.firstMarriageMaleMean.n })} />}
              {fams.firstMarriageFemaleMean && <StatTile tone="female" label={t("stats.meanMarriageWomen")} value={dec(fams.firstMarriageFemaleMean.value)} sub={t("stats.nPeople", { count: fams.firstMarriageFemaleMean.n })} />}
              <StatTile label={t("stats.families")} value={num(families)} />
              <StatTile label={t("stats.childless")} value={num(fams.children[0].count)} sub={pct(fams.children[0].count, families)} onClick={() => choose("famTiles", "childless", t("stats.childless"), fams.children[0].ids, true)} picked={pickedIn("famTiles") === "childless"} />
              {pick?.card === "famTiles" && (
                <PickList key={`famTiles:${pick.key}`} pick={pick} dataset={dataset} onNavigate={onNavigate} onClose={() => setPick(null)} />
              )}
            </section>
            {scope.sex !== "F" && card("marriageMen", t("stats.firstMarriageMen"), t("stats.nPeople", { count: total(fams.firstMarriageMale) }), buckets("marriageMen", t("stats.firstMarriageMen"), fams.firstMarriageMale, { tone: "male" }))}
            {scope.sex !== "M" && card("marriageWomen", t("stats.firstMarriageWomen"), t("stats.nPeople", { count: total(fams.firstMarriageFemale) }), buckets("marriageWomen", t("stats.firstMarriageWomen"), fams.firstMarriageFemale, { tone: "female" }))}
            {card("ageGap", t("stats.ageGap"), t("stats.ageGapNote", { count: total(fams.ageGap) }), buckets("ageGap", t("stats.ageGap"), fams.ageGap, { families: true, label: lowerBound, tipLabel: rangeLabel }))}
            {card("marriageMonth", t("stats.marriageMonth"), t("stats.nFamilies", { count: total(fams.marriageMonth) }), buckets("marriageMonth", t("stats.marriageMonth"), fams.marriageMonth, { families: true, label: monthLabel }))}
            {card("children", t("stats.childrenPerFamilyChart"), t("stats.nFamilies", { count: families }), buckets("children", t("stats.childrenPerFamilyChart"), fams.children, { families: true }))}
            {card("childrenByCentury", t("stats.childrenByCentury"), t("stats.byFamilyCentury"), centuries("childrenByCentury", t("stats.childrenByCentury"), fams.childrenByCentury, dec, { families: true }))}
            {card("firstChild", t("stats.firstChild"), t("stats.nFamilies", { count: total(fams.firstChild) }), buckets("firstChild", t("stats.firstChild"), fams.firstChild, { families: true, label: (b) => t(`stats.firstChild.${b.key}`) }))}
            {card("unions", t("stats.unionsPerPerson"), t("stats.nPeople", { count: total(fams.unionsPerPerson) }), buckets("unions", t("stats.unionsPerPerson"), fams.unionsPerPerson))}
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
                <PickList key={`birthTiles:${pick.key}`} pick={pick} dataset={dataset} onNavigate={onNavigate} onClose={() => setPick(null)} />
              )}
            </section>
            {card("birthDecade", t("stats.birthsOverTime"), null, buckets("birthDecade", t("stats.birthsOverTime"), births.perPeriod, { label: periodLabel, tipLabel: rangeLabel, labelEvery: periodStep(births.perPeriod) }), true)}
            {card("birthMonth", t("stats.birthsByMonth"), null, buckets("birthMonth", t("stats.birthsByMonth"), births.byMonth, { label: monthLabel }))}
            {card("baptism", t("stats.baptism"), t("stats.nPeople", { count: total(births.baptism) }), buckets("baptism", t("stats.baptism"), births.baptism, { label: (b) => t(`stats.baptism.${b.key}`) }))}
            {card("birthPlaces", t("stats.birthPlaces"), null, ranked("birthPlaces", t("stats.birthPlaces"), births.places, 15, undefined, true))}
          </>
        )}

        {deaths && (
          <>
            {card("causes", t("stats.causes"), null, ranked("causes", t("stats.causes"), deaths.causes, 15))}
            {card("causeAge", t("stats.causeAge"), t("stats.causeAgeNote", { n: CAUSE_AGE_MIN }), (
              <BarList
                limit={15}
                picked={pickedIn("causeAge")}
                rows={deaths.ageByCause.map((c) => ({ key: c.key, label: c.label, value: c.value, display: dec(c.value), count: c.ids.length, tip: t("stats.nPeople", { count: c.ids.length }) }))}
                onPick={(key) => {
                  const c = deaths.ageByCause.find((x) => x.key === key)!;
                  choose("causeAge", key, `${t("stats.causeAge")} — ${c.label}`, c.ids);
                }}
              />
            ))}
            {card("deathPlaces", t("stats.deathPlaces"), null, ranked("deathPlaces", t("stats.deathPlaces"), deaths.places, 15, undefined, true))}
            {card("deathDecade", t("stats.deathsOverTime"), null, buckets("deathDecade", t("stats.deathsOverTime"), deaths.perPeriod, { label: periodLabel, tipLabel: rangeLabel, labelEvery: periodStep(deaths.perPeriod) }), true)}
            {card("deathMonth", t("stats.deathsByMonth"), null, buckets("deathMonth", t("stats.deathsByMonth"), deaths.byMonth, { label: monthLabel }))}
          </>
        )}

        {jobs && (
          <>
            {card("occupations", t("stats.occupations"), null, ranked("occupations", t("stats.occupation"), jobs.occupations, 20))}
            {card("sonFatherJob", t("stats.sonFatherJob"), null, shares("sonFatherJob", [
              { key: "sonFather", label: t("stats.sonFatherJobRow"), share: jobs.sonFather, tone: "male" },
            ], false))}
            {card("jobsByCentury", t("stats.occupationsByCentury"), null, centuryTable(
              "jobsByCentury",
              [{ head: t("stats.occupations") }],
              jobs.byCentury.map((row) => ({ century: row.century, cells: [row.top] })),
            ), true)}
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
function PickList({ pick, dataset, onNavigate, onClose }: { pick: Pick; dataset: Dataset; onNavigate: (id: string) => void; onClose: () => void }) {
  const { t } = useTranslation();
  // The whole list, windowed: a bar can stand for half a million people, and
  // only the rows in the scroll box are ever mounted.
  const virtual = useVirtualList({ count: pick.ids.length, estimate: 34, itemsKey: pick.ids });
  return (
    <div className="stats-pick">
      <div className="stats-pick-head">
        <strong>{pick.title}</strong>
        <span className="muted">{pick.families ? t("stats.nFamilies", { count: pick.ids.length }) : t("stats.nPeople", { count: pick.ids.length })}</span>
        <button type="button" className="tools-issue-link stats-pick-close" onClick={onClose} aria-label={t("stats.closeList")}>✕</button>
      </div>
      <ul className="tools-issues">
        <li className="v-spacer" style={{ height: virtual.padTop }} ref={virtual.topRef} aria-hidden />
        {pick.ids.slice(virtual.start, virtual.end).map((id, k) => {
          const i = virtual.start + k;
          return (
            <li key={id} className={`tools-issue${i % 2 ? " zebra" : ""}`}>
              {pick.families ? <Couple dataset={dataset} id={id} onNavigate={onNavigate} /> : <PersonLink dataset={dataset} id={id} fallback={id} onNavigate={onNavigate} />}
            </li>
          );
        })}
        <li className="v-spacer" style={{ height: virtual.padBottom }} ref={virtual.bottomRef} aria-hidden />
      </ul>
    </div>
  );
}

/** A family as its couple — the spouses it names, or the record itself when it names none. */
function Couple({ dataset, id, onNavigate, nameOnly = false }: { dataset: Dataset; id: string; onNavigate: (id: string) => void; nameOnly?: boolean }) {
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
