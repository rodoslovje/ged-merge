import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, Family, Individual } from "../gedcom/types";
import { DEFAULT_SITE_DISPLAY, type PubFamily, type PubPerson, type PubSource, type PublishedTree, type PubEvent } from "../publish/model";
import { pubId, xrefOf } from "../publish/hydrate";
import { ChartsHub, HUB_KINDS } from "../ui/ChartsHub";
import { StatsPanel } from "../ui/tools/StatsPanel";
import type { ToolView } from "../ui/ToolsView";
import { PersonLink } from "../ui/PersonLink";
import { YearsText } from "../ui/YearsText";
import { useChartSettings, type ChartKind } from "../ui/ChartSettingsContext";
import { useNameOf, useSetSettings, useSettingsSlice } from "../ui/SettingsContext";
import { ChartIcon } from "../ui/icons/ChartIcon";
import { HomeIcon } from "../ui/icons/HomeIcon";
import { SearchIcon } from "../ui/icons/SearchIcon";
import { SunIcon } from "../ui/icons/SunIcon";
import { LockIcon } from "../ui/icons/LockIcon";
import { MoonIcon } from "../ui/icons/MoonIcon";
import { StatsIcon } from "../ui/icons/StatsIcon";
import { LogoMark } from "../ui/icons/LogoMark";
import { exportSiteLink } from "../ui/exportSvg";
import { lifespanApproxOf, lifespanOf } from "../gedcom/lifespan";
import { lifespanAge } from "../gedcom/age";
import { lifespanLine } from "../chart/nodeDisplay";
import { displayDateText } from "../gedcom/dateDisplay";
import { customEventLabel, EVENT_GLYPHS, eventDisplayLabel, familyEventLabel } from "../gedcom/eventTags";
import { LANGUAGE_NAMES, SUPPORTED_LANGUAGES } from "../locales/i18n";
import { StartPersonChip } from "../ui/edit/StartPersonChip";
import { StartPersonSelector } from "../ui/StartPersonSelector";
import { useDatasetDerivations } from "../ui/DatasetDerivations";
import { lineageClass, type KinshipResolver } from "../match/kinship";
import { useTheme } from "../ui/useTheme";
import { nameMatches, parseRoute, routeHash, startRoute, type Route } from "./route";
import { chartViewOf, chartViewWords } from "./chartRoute";
import { Highlights } from "./Highlights";
import { PersonCharts } from "./PersonCharts";
import { PhotoTray } from "./PhotoTray";
import { familyEventAges, personEventAges } from "./ages";
import type { AgeBadge } from "../gedcom/age";
import { ShortcutsModal } from "../ui/ShortcutsModal";
import { KEY, SITE_SHORTCUT_GROUPS, familyStepFor, isEditableTarget, isModalOpen, keyHint } from "../keyboard/shortcuts";
import { familyStepTarget } from "../gedcom/familyNav";
import { PersonMedia } from "../ui/PersonMedia";
import { MapIcon } from "../ui/icons/MapIcon";

const MiniPlaceMap = lazy(() => import("../ui/map/MiniPlaceMap"));
import type { ChartDirection } from "../chart/treeLayout";

/** Search results listed at most; the reader narrows the query for more. */
const SEARCH_LIMIT = 100;

/** The page in the address; an address without one is the author's start page
 *  (`#/` is the front page itself). */
function useRoute(start: Route): [Route, (r: Route) => void, (r: Route) => void] {
  const read = () => (location.hash ? parseRoute(location.hash) : start);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onHash = () => {
      setRoute(location.hash ? parseRoute(location.hash) : start);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [start]);
  const go = (r: Route) => { location.hash = routeHash(r); };
  // The same page, said more exactly (which chart): the address changes, the
  // history gains no step.
  const replace = (r: Route) => {
    history.replaceState(history.state, "", routeHash(r));
    setRoute(r);
  };
  return [route, go, replace];
}

const isHubKind = (k: string | undefined): k is ChartKind => !!k && (HUB_KINDS as readonly string[]).includes(k);

/** The published people and families by dataset id: the person page shows
 *  their events, notes and sources as published, links and all. */
interface PubIndex {
  people: Map<string, PubPerson>;
  families: Map<string, PubFamily>;
}


/** The visitor's own start person, kept in their browser — for this site
 *  alone: two family websites on one host (or two files opened from disk)
 *  share the browser's storage, and their person ids may coincide. */
const START_KEY = `gedmerge-site.start:${location.pathname}`;
/** Stored when the visitor clears the start person (no xref looks like it). */
const NO_START = "none";
const KINSHIP_KEYS = ["showKinship"] as const;
const AGE_KEYS = ["showAge"] as const;
const DATE_KEYS = ["dateDisplay"] as const;

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | undefined): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Storage blocked: the choice lasts for this visit.
  }
}

/** A person link followed by how they are related to the start person, in the
 *  lineage colours the app uses. */
function KinLink({ ds, id, kin, onNavigate }: { ds: Dataset; id: string; kin?: KinshipResolver; onNavigate: (id: string) => void }) {
  const label = kin?.label(id);
  return (
    <>
      <PersonLink dataset={ds} id={id} fallback={id} onNavigate={onNavigate} />
      {label && <span className={`person-kinship ${lineageClass(kin?.lineage(id), kin?.direct(id))}`}>{label}</span>}
    </>
  );
}

export function ViewerApp({ tree, ds }: { tree: PublishedTree; ds: Dataset }) {
  const { t, i18n } = useTranslation();
  const start = useMemo(() => startRoute(tree.startPage, tree.start), [tree]);
  const [route, go, replace] = useRoute(start);
  const { theme, changeThemeMode } = useTheme();
  // The two toggles show what a click switches to: the other theme, the other
  // language (the site has two). Their tooltips name it in full.
  const otherTheme = theme === "dark" ? "light" : "dark";
  const otherLang = SUPPORTED_LANGUAGES.find((l) => l !== i18n.language) ?? "en";
  // The button shows the language the site is in; its tooltip names the switch.
  const lang = SUPPORTED_LANGUAGES.find((l) => l !== otherLang) ?? "sl";
  const langSwitch = `${LANGUAGE_NAMES[lang]} → ${LANGUAGE_NAMES[otherLang]}`;
  const setSettings = useSetSettings();
  const { settings: chartSettings, setKind, set: setChartSettings } = useChartSettings();
  // Ancestors, descendants or both: the site keeps it, so the address can.
  const [direction, setDirection] = useState<ChartDirection>("both");
  // The site has no Settings page: people are shown as the author chose when
  // publishing (names, dates, ages, kinship), the map draws the base and the
  // layers they chose, and may load its tiles.
  useEffect(() => {
    const map = tree.map ? { mapBasemap: tree.map.basemap, mapTileUrl: tree.map.tileUrl, mapOverlays: tree.map.overlays } : {};
    setSettings({ ...DEFAULT_SITE_DISPLAY, ...tree.display, ...map, allowMapTiles: true, showXref: false });
  }, [setSettings, tree.display, tree.map]);
  useEffect(() => { document.title = tree.title || t("site.untitled"); }, [tree.title, t]);

  // The start person relationships are named from: the author's, until the
  // visitor picks their own or clears it (remembered in their browser; a
  // cleared one as NO_START, so it does not fall back to the author's).
  // The author's own address, normalized as the exports name it (https:// added).
  const homeUrl = tree.url ? exportSiteLink().url : undefined;
  const authorStart = tree.start ? xrefOf(tree.start) : undefined;
  const [ownStart, setOwnStart] = useState<string | undefined>(() => {
    const saved = readStored(START_KEY);
    return saved === NO_START || (saved && ds.individuals.has(saved)) ? saved : undefined;
  });
  const startXref = ownStart === NO_START ? undefined : ownStart ?? authorStart;
  const chooseStart = (id: string | undefined) => {
    const own = id === undefined ? (authorStart ? NO_START : undefined) : id === authorStart ? undefined : id;
    setOwnStart(own);
    writeStored(START_KEY, own);
  };
  // Where Charts opens: the start person, else the author's.
  const chartsRoot = startXref ?? authorStart;
  // Each view of each person's chart has its own address
  // (`#/c/<person>/<kind>/<view words>`, see `chartRoute.ts`): an address names
  // the chart and how it is drawn, and changing either updates the address.
  // `applied` is the last address put into effect, so a change made in the hub
  // is not undone by the address it is still on.
  const applied = useRef<string | undefined>(undefined);
  // The relationship's other person: the one its address names, else the one
  // Statistics opened it from, else the start person (see relationWord).
  const addressFrom = route.page === "charts" && route.kind === "relationship" && route.view?.[0] && ds.individuals.has(xrefOf(route.view[0]))
    ? xrefOf(route.view[0])
    : undefined;
  const [relationFrom, setRelationFrom] = useState<string | undefined>();
  useEffect(() => { if (addressFrom) setRelationFrom(addressFrom); }, [addressFrom]);
  const relationWord = (from: string | undefined) => (from ? pubId(from) : undefined);
  const shownWords = chartViewWords(chartSettings.kind, chartSettings, direction, relationWord(addressFrom ?? relationFrom ?? startXref));
  const shownKey = [chartSettings.kind, ...shownWords].join("/");
  // The view an address was just put into effect as, until the charts show it:
  // the settings arrive a render later, and the view on screen in between is
  // not a change of the reader's to write back into the address.
  const awaiting = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (route.page !== "charts") return;
    const addressKey = [route.kind, ...(route.view ?? [])].join("/");
    if (isHubKind(route.kind) && addressKey !== applied.current) {
      applied.current = addressKey;
      const view = chartViewOf(route.kind, route.view ?? []);
      const expected = [route.kind, ...chartViewWords(route.kind, { ...chartSettings, ...view.settings }, view.direction, relationWord(addressFrom ?? relationFrom ?? startXref))].join("/");
      // Already on screen (the hub changed the kind itself): nothing to wait for.
      awaiting.current = expected === shownKey ? undefined : expected;
      if (route.kind !== chartSettings.kind) setKind(route.kind);
      setChartSettings(view.settings);
      setDirection(view.direction);
      return;
    }
    if (awaiting.current !== undefined) {
      if (shownKey !== awaiting.current) return;
      awaiting.current = undefined;
    }
    if (addressKey !== shownKey) replace({ page: "charts", id: route.id, kind: chartSettings.kind, view: shownWords.length ? shownWords : undefined });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- replace and shownWords are fresh each render; shownKey stands for them
  }, [route, shownKey, setKind, setChartSettings]);
  const derivations = useDatasetDerivations();
  // Kinship labels follow the author's display choice, as everywhere in the app.
  const { showKinship } = useSettingsSlice(KINSHIP_KEYS);
  const kin = startXref && showKinship ? derivations?.kinship(startXref) : undefined;
  const pub = useMemo<PubIndex>(() => ({
    people: new Map(tree.people.map((p) => [xrefOf(p.id), p])),
    families: new Map(tree.families.map((f) => [xrefOf(f.id), f])),
  }), [tree]);
  const openPerson = (xref: string) => go({ page: "person", id: pubId(xref) });
  // A person's charts, drawn as the charts are now. Re-rooting on the person
  // already shown (the hub does so as it opens) leaves the address alone.
  const openCharts = (xref: string) => {
    // The address as it is now, not as this render saw it: the hub re-roots as
    // it opens, before a render with the chart's own address.
    const now = parseRoute(location.hash);
    if (now.page === "charts" && xrefOf(now.id) === xref) return;
    go({ page: "charts", id: pubId(xref), kind: chartSettings.kind, view: shownWords.length ? shownWords : undefined });
  };
  // The header's search, on whatever page the reader is: a person found there
  // takes the charts' place on a chart page, and opens their own page anywhere
  // else. It folds away again once someone is picked.
  const [searching, setSearching] = useState(false);
  const pickFound = (xref: string | undefined) => {
    setSearching(false);
    if (!xref) return;
    if (route.page === "charts") openCharts(xref);
    else openPerson(xref);
  };

  // The keyboard, with the app's own keys (SITE_SHORTCUT_GROUPS lists them):
  // `/` the search, `?` the list, H the start person, V the charts, S the
  // relationship, Alt+arrows a step through the family, ⌫ back. A chart page
  // keeps its own letters (ChartsHub's).
  const [showKeys, setShowKeys] = useState(false);
  const shownPerson = route.page === "person" ? xrefOf(route.id) : undefined;
  // The person before this one: a partner step toggles between the two.
  const lastPerson = useRef<{ now?: string; before?: string }>({});
  useEffect(() => {
    if (shownPerson && shownPerson !== lastPerson.current.now) lastPerson.current = { now: shownPerson, before: lastPerson.current.now };
  }, [shownPerson]);
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    onKey.current = (e) => {
      // The page as the address says now: a key pressed right after another
      // may come before the render that follows the first.
      const live = parseRoute(location.hash);
      const shownPerson = live.page === "person" && ds.individuals.has(xrefOf(live.id)) ? xrefOf(live.id) : undefined;
      const editable = isEditableTarget(e.target);
      if (e.key === "F1" || (e.key === "?" && !editable)) {
        e.preventDefault();
        setShowKeys((v) => (!v && isModalOpen() ? v : !v));
        return;
      }
      if (editable || isModalOpen() || e.metaKey || e.ctrlKey || e.defaultPrevented) return;
      if (e.altKey) {
        const step = familyStepFor(e.key, e.shiftKey);
        if (!step || !shownPerson) return;
        e.preventDefault();
        const to = familyStepTarget(ds, shownPerson, step, lastPerson.current.before);
        if (to) openPerson(to);
        return;
      }
      if (e.key === "Backspace" && !e.shiftKey) {
        e.preventDefault();
        history.back();
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        setSearching(true);
        return;
      }
      // S: the statistics, from any page, a chart page too.
      if (e.key.toLowerCase() === KEY.stats && !e.shiftKey) {
        e.preventDefault();
        go({ page: "stats" });
        return;
      }
      if (live.page === "charts" || e.shiftKey) return;
      const key = e.key.toLowerCase();
      const here = shownPerson ?? chartsRoot;
      if (key === KEY.home && startXref) {
        e.preventDefault();
        openPerson(startXref);
      } else if (key === KEY.tree && here) {
        e.preventDefault();
        openCharts(here);
      } else if ((key === KEY.fan || key === KEY.timeline || key === KEY.map) && here) {
        e.preventDefault();
        go({ page: "charts", id: pubId(here), kind: key === KEY.fan ? "fan" : key === KEY.timeline ? "timeline" : "map" });
      } else if (key === KEY.relationship && shownPerson && startXref && shownPerson !== startXref) {
        e.preventDefault();
        go({ page: "charts", id: pubId(shownPerson), kind: "relationship" });
      }
    };
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const header = (
    <header className="app-head site-head">
      <div className="app-head-top">
        <a className="site-title" href="#/">{tree.title || t("site.untitled")}</a>
        <nav className="site-nav">
          {/* Home: the author's own site when they named its address (a way back
              to the page listing their trees), else this site's front page —
              which the title always opens. */}
          <a className={`nav-btn${!homeUrl && route.page === "home" ? " active" : ""}`} href={homeUrl ?? "#/"}>
            <HomeIcon size={16} /> {t("site.nav.home")}
          </a>
          {chartsRoot && (
            <a
              className={`nav-btn${route.page === "charts" ? " active" : ""}`}
              href={routeHash({ page: "charts", id: pubId(chartsRoot) })}
              title={keyHint(t("site.nav.charts"), KEY.tree.toUpperCase())}
            >
              <ChartIcon size={16} /> {t("site.nav.charts")}
            </a>
          )}
          <a
            className={`nav-btn${route.page === "stats" ? " active" : ""}`}
            href="#/stats"
            title={keyHint(t("site.nav.stats"), KEY.stats.toUpperCase())}
          >
            <StatsIcon size={16} /> {t("site.nav.stats")}
          </a>
        </nav>
        <div className="site-prefs">
          <button
            type="button"
            className="nav-btn icon-only site-toggle site-theme"
            onClick={() => changeThemeMode(otherTheme)}
            title={t(`site.theme.${otherTheme}`)}
            aria-label={t(`site.theme.${otherTheme}`)}
          >
            {otherTheme === "light" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
          </button>
          <button
            type="button"
            className="nav-btn icon-only site-toggle site-lang"
            onClick={() => void i18n.changeLanguage(otherLang)}
            title={langSwitch}
            aria-label={langSwitch}
          >
            {/* The language as its code, not a flag: a flag names a country. */}
            {lang.toUpperCase()}
          </button>
          <button
            type="button"
            className={`nav-btn icon-only site-toggle site-search-btn${searching ? " active" : ""}`}
            onClick={() => setSearching((s) => !s)}
            title={keyHint(t("site.search.label"), "/")}
            aria-label={t("site.search.label")}
            aria-expanded={searching}
          >
            <SearchIcon size={16} />
          </button>
          <button
            type="button"
            className="nav-btn icon-only site-toggle site-keys"
            onClick={() => setShowKeys(true)}
            title={keyHint(t("shortcuts.title"), "?")}
            aria-label={t("shortcuts.title")}
          >
            ?
          </button>
          <ShortcutsModal isOpen={showKeys} onClose={() => setShowKeys(false)} groups={SITE_SHORTCUT_GROUPS} compact />
        </div>
      </div>
      {searching && (
        <div className="site-search-pop" onKeyDown={(e) => { if (e.key === "Escape") setSearching(false); }}>
          <StartPersonSelector
            individuals={ds.individuals}
            version={0}
            startId={undefined}
            onChange={pickFound}
            icon="search"
            autoFocus
            placeholder={t(route.page === "charts" ? "site.search.chartPlaceholder" : "site.search.placeholder")}
            tooltip={t("site.search.label")}
          />
        </div>
      )}
    </header>
  );

  const footer = <SiteFooter created={tree.created} />;

  if (route.page === "charts" && ds.individuals.has(xrefOf(route.id))) {
    const rootId = xrefOf(route.id);
    return (
      <div className="app tree-shell site">
        {header}
        <ChartsHub
          mainDs={ds}
          rootId={rootId}
          onRootChange={openCharts}
          startId={startXref}
          relationFromId={addressFrom ?? relationFrom}
          changedPersonIds={EMPTY}
          backLabel={t("site.back.person")}
          onBack={() => openPerson(rootId)}
          onNavigate={openPerson}
          direction={direction}
          onDirectionChange={setDirection}
        />
        {footer}
      </div>
    );
  }

  let body: ReactNode;
  if (route.page === "person" && ds.individuals.has(xrefOf(route.id))) {
    const id = xrefOf(route.id);
    body = (
      <PersonPage
        ds={ds}
        id={id}
        pub={pub}
        kin={kin}
        startId={startXref}
        onStartChange={chooseStart}
        onNavigate={openPerson}
      />
    );
  } else if (route.page === "stats") {
    body = (
      <>
        <h1 className="site-page-title">{t("site.nav.stats")}</h1>
        <div className="tools-view site-stats">
          <div className="tools-panel">
            <StatsPanel
              dataset={ds}
              editVersion={0}
              onNavigate={openPerson}
              onOpenRelationship={(from, to) => {
                // Straight to the address that names them both.
                setRelationFrom(from);
                go({ page: "charts", id: pubId(to), kind: "relationship", view: [pubId(from)] });
              }}
              fileName={tree.title || "family-tree"}
              active
              startId={startXref}
              view={(route.view ?? "tree") as ToolView}
              onViewChange={(view) => go({ page: "stats", view })}
            />
          </div>
        </div>
      </>
    );
  } else {
    body = <HomePage tree={tree} ds={ds} startId={startXref} kin={kin} onNavigate={openPerson} />;
  }

  return (
    <div className="app site">
      {header}
      <main className="site-main">{body}</main>
      {footer}
    </div>
  );
}

/** The foot of every page: made with GED Merge (its mark, linked to
 *  gedmerge.com), on the day the site was published. */
function SiteFooter({ created }: { created: string }) {
  const { t, i18n } = useTranslation();
  return (
    <footer className="site-foot">
      {t("site.footer.madeWith")}{" "}
      <a className="site-foot-brand" href="https://gedmerge.com" target="_blank" rel="noopener">
        <LogoMark size={16} /> GED Merge
      </a>
      <span aria-hidden="true">·</span>
      <time dateTime={created}>{new Date(created).toLocaleDateString(i18n.language)}</time>
    </footer>
  );
}

const EMPTY = new Set<string>();

function HomePage({ tree, ds, startId, kin, onNavigate }: {
  tree: PublishedTree;
  ds: Dataset;
  startId?: string;
  kin?: KinshipResolver;
  onNavigate: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const nameOf = useNameOf();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  // A surname picked among the highlights: search for it, in view.
  const searchSurname = (surname: string) => {
    setQuery(surname);
    searchRef.current?.focus();
    searchRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const results = useMemo(() => {
    if (!query.trim()) return [];
    const out: Individual[] = [];
    for (const indi of ds.individuals.values()) {
      if (nameMatches(nameOf(indi), query)) out.push(indi);
    }
    return out.sort((a, b) => nameOf(a).localeCompare(nameOf(b), i18n.language));
  }, [ds, query, nameOf, i18n.language]);
  // The author's words in the reader's language, else in the other one.
  const intro = tree.intro?.[i18n.language] ?? Object.values(tree.intro ?? {})[0];
  const coverPath = tree.cover ? tree.photos?.find((p) => p.id === tree.cover)?.path : undefined;

  return (
    <div className="site-home">
      {/* A row of faces from the family's photos, each opening that person. */}
      <PhotoTray tree={tree} ds={ds} onNavigate={onNavigate} />
      {/* The title, the author's words and the search, and the cover photo beside them. */}
      <section className={`site-hero${coverPath ? " has-cover" : ""}`}>
        {coverPath && <img className="site-cover" src={coverPath} alt="" />}
        <div className="site-hero-text">
          <h1>{tree.title || t("site.untitled")}</h1>
          {intro && <p className="site-intro">{intro}</p>}
          {/* The search under the words, beside the cover photo. */}
          <section className="site-search">
            <label className="site-search-label" htmlFor="site-search">{t("site.search.label")}</label>
            {/* The field with its magnifier inside, at the left. */}
            <span className="site-search-field">
              <SearchIcon size={16} />
              <input
                id="site-search"
                ref={searchRef}
                type="search"
                className="tools-search-input site-search-input"
                value={query}
                placeholder={t("site.search.placeholder")}
                onChange={(e) => setQuery(e.target.value)}
                autoComplete="off"
              />
            </span>
            {/* The search first; the start person is the other way in. */}
            {startId && ds.individuals.has(startId) && (
              <p className="site-start">
                {t("site.start")}{" "}
                <PersonLink dataset={ds} id={startId} fallback={startId} onNavigate={onNavigate} />
              </p>
            )}
            {query.trim() && (
              <>
                <p className="site-search-count">
                  {results.length > SEARCH_LIMIT
                    ? t("site.search.more", { shown: SEARCH_LIMIT, count: results.length })
                    : t("site.search.count", { count: results.length })}
                </p>
                <ul className="site-person-list">
                  {results.slice(0, SEARCH_LIMIT).map((indi) => (
                    <li key={indi.id}>
                      <KinLink ds={ds} id={indi.id} kin={kin} onNavigate={onNavigate} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>
      </section>
      <Highlights ds={ds} onNavigate={onNavigate} onSurname={searchSurname} />
    </div>
  );
}

/** One source citation: the source, the cited page, linked where it can be. */
function SourceLine({ s }: { s: PubSource }) {
  const { t } = useTranslation();
  // A bare number is named a page; a page the file already words ("fol. 3",
  // "Str. 12") stays as written.
  const page = s.page && (/^\d/.test(s.page) ? t("site.person.page", { page: s.page }) : s.page);
  const text = [s.title, page].filter(Boolean).join(", ") || s.url;
  return s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer">{text}</a> : <>{text}</>;
}

/** A record's own notes and sources, under its events. */
function RecordExtras({ notes, sources }: { notes?: string[]; sources?: PubSource[] }) {
  const { t } = useTranslation();
  return (
    <>
      {notes && (
        <div className="site-notes">
          <h4>{t("site.person.notes")}</h4>
          {notes.map((n, i) => <p key={i} className="site-note-text">{n}</p>)}
        </div>
      )}
      {sources && (
        <div className="site-sources">
          <h4>{t("site.person.sources")}</h4>
          <ul>{sources.map((s, i) => <li key={i}><SourceLine s={s} /></li>)}</ul>
        </div>
      )}
    </>
  );
}

/** The events as published: the date in the site's date display, the place
 *  (and address, where published) as text, then the event's notes and sources. */
/** Age badges, "35" or "♂32 ♀28", each with its full age as tooltip. */
function ageBadges(badges: AgeBadge[] | undefined) {
  if (!badges) return null;
  return (
    <span className="site-event-age">
      {badges.map((a, i) => <span key={i} title={a.title}>{a.text}</span>)}
    </span>
  );
}

function EventRows({ events, family, ages }: {
  events: PubEvent[] | undefined;
  family?: boolean;
  /** The ages beside each event, as Edit shows them (see ages.ts). */
  ages?: (e: PubEvent) => AgeBadge[] | undefined;
}) {
  const { t, i18n } = useTranslation();
  // Re-drawn when the date display is set (the site sets it as it opens).
  useSettingsSlice(DATE_KEYS);
  // The event whose place is shown on a small map under it, if any.
  const [mapped, setMapped] = useState<number | null>(null);
  if (!events?.length) return null;
  return (
    <dl className="site-events">
      {events.map((e, i) => {
        const label = (e.tag === "EVEN" || e.tag === "FACT") && e.type
          ? customEventLabel(e.type, t, i18n.language)
          : family ? familyEventLabel(e.tag, t) : eventDisplayLabel(e.tag, t);
        const date = e.date && displayDateText(e.date);
        const where = [e.address, e.place].filter(Boolean).join(", ");
        const coord = e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : undefined;
        return (
          <div key={i} className="site-event">
            {/* The event's mark, then its name. */}
            <dt>
              <span className="site-event-glyph" aria-hidden="true">{EVENT_GLYPHS[e.tag] ?? "•"}</span>
              {label}
            </dt>
            <dd>
              {e.value}
              {e.value && date && ", "}
              {date && <span className="site-event-date gm-data">{date}</span>}
              {(e.value || date) && where && " · "}
              {/* A place with a coordinate opens it on a small map, in place. */}
              {where && coord ? (
                <button
                  type="button"
                  className="tools-issue-link site-place-link"
                  aria-expanded={mapped === i}
                  title={t("site.person.showOnMap")}
                  onClick={() => setMapped(mapped === i ? null : i)}
                >
                  <MapIcon size={13} /> {where}
                </button>
              ) : where}
              {e.cause && <span className="site-event-cause"> ({e.cause})</span>}
              {/* The ages at the event, each with its full age as tooltip. */}
              {ageBadges(ages?.(e))}
              {mapped === i && coord && (
                <span className="site-event-map">
                  <Suspense fallback={null}>
                    <MiniPlaceMap
                      pins={[{ coord, label: e.place ?? where, ...(e.address ? { sub: e.address } : {}), kind: "chosen" }]}
                      fitKey={`${i}:${coord.lat}:${coord.lon}`}
                      fitMaxZoom={e.address ? 16 : 13}
                    />
                  </Suspense>
                </span>
              )}
              {e.notes?.map((n, j) => <span key={j} className="site-event-note">{n}</span>)}
              {e.sources?.map((s, j) => (
                <span key={j} className="site-event-source">
                  {t("site.person.source")}: <SourceLine s={s} />
                </span>
              ))}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function PersonPage({ ds, pub, id, kin, startId, onStartChange, onNavigate }: {
  ds: Dataset;
  /** The published records, by dataset id: what the page shows of each. */
  pub: PubIndex;
  id: string;
  kin?: KinshipResolver;
  startId: string | undefined;
  /** Pick the start person; undefined goes back to the author's. */
  onStartChange: (id: string | undefined) => void;
  onNavigate: (id: string) => void;
}) {
  const { t } = useTranslation();
  const nameOf = useNameOf();
  const indi = ds.individuals.get(id)!;
  const link = (pid: string | undefined) => pid && ds.individuals.has(pid)
    ? <KinLink ds={ds} id={pid} kin={kin} onNavigate={onNavigate} />
    : null;
  const startIndi = startId ? ds.individuals.get(startId) : undefined;
  const { showAge } = useSettingsSlice(AGE_KEYS);
  const parentFams = indi.childOf.map((f) => ds.families.get(f)).filter((f): f is Family => !!f);
  const ownFams = indi.spouseOf.map((f) => ds.families.get(f)).filter((f): f is Family => !!f);
  const siblings = [...new Set(parentFams.flatMap((f) => f.children))].filter((c) => c !== id);
  const person = pub.people.get(id);
  // The start person's control, as in the app's Edit view: the kinship label
  // itself opens the menu (go to the start person, make this one the start,
  // choose another, clear), a bare ⌂ where there is no label.
  const kinship = kin?.label(id);
  const bareHome = !!startId && !kinship;
  const startChip = (
    <StartPersonChip
      t={t}
      personId={id}
      startId={startId}
      startName={startIndi ? nameOf(startIndi) : undefined}
      kinship={kinship}
      kinshipLineage={lineageClass(kin?.lineage(id), kin?.direct(id))}
      individuals={ds.individuals}
      onChange={onStartChange}
      onGoToStart={() => startId && onNavigate(startId)}
    />
  );

  return (
    <article className="site-person">
      {/* Who they are on the left — name, years, kinship — and their charts
          on the right. */}
      <header className="site-person-head">
        <div className="site-person-id">
          <div className="site-person-title">
            {/* The sex as a small mark before the name (the name itself in text
                ink), and in words for a screen reader. */}
            {(indi.sex === "M" || indi.sex === "F") && (
              <>
                <span className={`sex-badge site-sex-badge ${indi.sex === "M" ? "m" : "f"}`} aria-hidden="true">
                  {indi.sex === "M" ? "♂" : "♀"}
                </span>
                <span className="site-sr-only">{t(`sex.${indi.sex}`)}</span>
              </>
            )}
            <h2 className="site-person-name">{nameOf(indi)}</h2>
            <span className="site-person-years">
              <YearsText text={lifespanLine({ showLifespan: true, showAge }, { years: lifespanOf(indi), age: lifespanAge(indi) }) ?? ""} approx={lifespanApproxOf(indi)} />
            </span>
            {/* No kinship to name: the bare ⌂ rides after the years rather
                than taking a line of its own. */}
            {bareHome && startChip}
          </div>
          {!bareHome && <div className="site-person-kinship">{startChip}</div>}
        </div>
        <PersonCharts
          ds={ds}
          id={id}
          startId={startId}
          kinship={kin?.label(id)}
          timeline={!(person?.living && !person.events?.length)}
        />
      </header>
      {/* Details withheld: said once, as a small notice with a padlock. */}
      {person?.living && (
        <p className="site-note">
          <LockIcon size={14} />
          {t(person.deceased ? "site.person.recentDead" : "site.person.living")}
        </p>
      )}
      {/* Their photos: a strip that opens each in the viewer, with the people
          tagged on it. */}
      <PersonMedia raw={indi.raw} records={ds.records} refCtx={{ dataset: ds, onNavigate, hideFile: true }} />
      <EventRows events={person?.events} ages={showAge ? personEventAges(ds, indi, t) : undefined} />
      <RecordExtras notes={person?.notes} sources={person?.sources} />

      {/* The family as cards: parents and siblings side by side where there
          is room, each family of their own (its events, its children) across
          the whole width. */}
      <div className="site-family">
        {parentFams.length > 0 && (
          <section className="site-section">
            <h3>{t("site.person.parents")}</h3>
            {parentFams.map((f) => (
              <ul key={f.id} className="site-person-list">
                {f.husband && <li>{link(f.husband)}</li>}
                {f.wife && <li>{link(f.wife)}</li>}
              </ul>
            ))}
          </section>
        )}

        {siblings.length > 0 && (
          <section className="site-section">
            <h3>{t("site.person.siblings", { count: siblings.length })}</h3>
            <ul className="site-person-list">
              {siblings.map((c) => <li key={c}>{link(c)}</li>)}
            </ul>
          </section>
        )}

        {ownFams.map((f) => {
          const partner = f.husband === id ? f.wife : f.husband;
          return (
            <section key={f.id} className="site-section site-section-family">
              <h3>{partner ? t("site.person.partner") : t("site.person.family")}</h3>
              {partner && <p className="site-partner">{link(partner)}</p>}
              <EventRows events={pub.families.get(f.id)?.events} family ages={showAge ? familyEventAges(ds, f, t) : undefined} />
              <RecordExtras notes={pub.families.get(f.id)?.notes} sources={pub.families.get(f.id)?.sources} />
              {f.children.length > 0 && (
                <>
                  <h4>{t("site.person.children", { count: f.children.length })}</h4>
                  <ul className="site-person-list">
                    {f.children.map((c) => <li key={c}>{link(c)}</li>)}
                  </ul>
                </>
              )}
            </section>
          );
        })}
      </div>
    </article>
  );
}
