import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, Family, GedEvent, Individual } from "../gedcom/types";
import type { PublishedTree } from "../publish/model";
import { pubId, xrefOf } from "../publish/hydrate";
import { ChartsHub } from "../ui/ChartsHub";
import { StatsPanel } from "../ui/tools/StatsPanel";
import type { ToolView } from "../ui/ToolsView";
import { PersonLink } from "../ui/PersonLink";
import { YearsText } from "../ui/YearsText";
import { useChartSettings } from "../ui/ChartSettingsContext";
import { useNameOf, useSetSettings } from "../ui/SettingsContext";
import { sexClass } from "../ui/sex";
import { ChartIcon } from "../ui/icons/ChartIcon";
import { HomeIcon } from "../ui/icons/HomeIcon";
import { lifespanOf } from "../gedcom/lifespan";
import { displayDate } from "../gedcom/dateDisplay";
import { customEventLabel, eventDisplayLabel, familyEventLabel } from "../gedcom/eventTags";
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, type Language } from "../locales/i18n";
import { PickerMenu } from "../ui/PickerMenu";
import { StartPersonSelector } from "../ui/StartPersonSelector";
import { useDatasetDerivations } from "../ui/DatasetDerivations";
import { lineageClass, type KinshipResolver } from "../match/kinship";
import { THEME_MODES, useTheme, type ThemeMode } from "../ui/useTheme";
import { nameMatches, parseRoute, routeHash, startRoute, type Route } from "./route";

/** Search results listed at most; the reader narrows the query for more. */
const SEARCH_LIMIT = 100;

/** The page in the address; an address without one is the author's start page
 *  (`#/` is the front page itself). */
function useRoute(start: Route): [Route, (r: Route) => void] {
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
  return [route, (r) => { location.hash = routeHash(r); }];
}

const THEME_GLYPH: Record<ThemeMode, string> = { auto: "☀☾", light: "☀", dark: "☾" };

/** The visitor's own start person, kept in their browser. */
const START_KEY = "gedmerge-site.start";

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
  const [route, go] = useRoute(start);
  const { themeMode, changeThemeMode } = useTheme();
  const setSettings = useSetSettings();
  const { setKind } = useChartSettings();
  // The site has no Settings page: dates read in words, in the reader's
  // language, and the map may load its tiles — the author chose to publish.
  useEffect(() => { setSettings({ dateDisplay: "words", allowMapTiles: true, showXref: false }); }, [setSettings]);
  useEffect(() => { document.title = tree.title || t("site.untitled"); }, [tree.title, t]);

  // The start person relationships are named from: the author's, until the
  // visitor picks their own (remembered in their browser).
  const authorStart = tree.start ? xrefOf(tree.start) : undefined;
  const [ownStart, setOwnStart] = useState<string | undefined>(() => {
    const saved = readStored(START_KEY);
    return saved && ds.individuals.has(saved) ? saved : undefined;
  });
  const startXref = ownStart ?? authorStart;
  const chooseStart = (id: string | undefined) => {
    const own = id === authorStart ? undefined : id;
    setOwnStart(own);
    writeStored(START_KEY, own);
  };
  const derivations = useDatasetDerivations();
  const kin = startXref ? derivations?.kinship(startXref) : undefined;
  const living = useMemo(() => new Set(tree.people.filter((p) => p.living).map((p) => xrefOf(p.id))), [tree]);
  const [relationFrom, setRelationFrom] = useState<string | undefined>();
  const openPerson = (xref: string) => go({ page: "person", id: pubId(xref) });
  const openCharts = (xref: string) => go({ page: "charts", id: pubId(xref) });

  const header = (
    <header className="app-head site-head">
      <div className="app-head-top">
        <a className="site-title" href="#/">{tree.title || t("site.untitled")}</a>
        <nav className="site-nav">
          <a className={`nav-btn${route.page === "home" ? " active" : ""}`} href="#/">{t("site.nav.home")}</a>
          {startXref && (
            <a className={`nav-btn${route.page === "charts" ? " active" : ""}`} href={routeHash({ page: "charts", id: pubId(startXref) })}>
              <ChartIcon size={16} /> {t("site.nav.charts")}
            </a>
          )}
          <a className={`nav-btn${route.page === "stats" ? " active" : ""}`} href="#/stats">{t("site.nav.stats")}</a>
        </nav>
        <div className="site-prefs">
          <div className="site-startpick">
            <StartPersonSelector
              individuals={ds.individuals}
              version={0}
              startId={startXref}
              onChange={chooseStart}
              placeholder={t("site.startPick.placeholder")}
              tooltip={t("site.startPick.hint")}
              onStartClick={ownStart ? () => chooseStart(undefined) : startXref ? () => openPerson(startXref) : undefined}
              startClickTitle={ownStart ? t("site.startPick.reset") : t("start.goto")}
            />
          </div>
          <PickerMenu
            className="site-picker site-theme"
            label={t("settings.appearance.title")}
            value={themeMode}
            onChange={changeThemeMode}
            items={THEME_MODES.map((m) => ({ key: m, label: `${THEME_GLYPH[m]} ${t(`settings.theme.${m}`)}` }))}
          />
          <PickerMenu
            className="site-picker site-lang"
            label={t("settings.language.title")}
            value={i18n.language as Language}
            onChange={(lng) => void i18n.changeLanguage(lng)}
            items={SUPPORTED_LANGUAGES.map((lng) => ({ key: lng, label: LANGUAGE_LABELS[lng] }))}
          />
        </div>
      </div>
    </header>
  );

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
          relationFromId={relationFrom}
          changedPersonIds={EMPTY}
          backLabel={t("site.back.person")}
          onBack={() => openPerson(rootId)}
          onNavigate={openPerson}
        />
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
        living={living.has(id)}
        kin={kin}
        isStart={id === startXref}
        onMakeStart={() => chooseStart(id)}
        onNavigate={openPerson}
        onCharts={() => openCharts(id)}
      />
    );
  } else if (route.page === "stats") {
    body = (
      <div className="tools-view site-stats">
        <div className="tools-panel">
          <StatsPanel
            dataset={ds}
            editVersion={0}
            onNavigate={openPerson}
            onOpenRelationship={(from, to) => {
              setRelationFrom(from);
              setKind("relationship");
              openCharts(to);
            }}
            fileName={tree.title || "family-tree"}
            active
            startId={startXref}
            view={(route.view ?? "tree") as ToolView}
            onViewChange={(view) => go({ page: "stats", view })}
          />
        </div>
      </div>
    );
  } else {
    body = <HomePage tree={tree} ds={ds} startId={startXref} kin={kin} onNavigate={openPerson} />;
  }

  return (
    <div className="app site">
      {header}
      <main className="site-main">{body}</main>
      <footer className="site-foot">
        {t("site.footer", { date: new Date(tree.created).toLocaleDateString(i18n.language) })}
      </footer>
    </div>
  );
}

const EMPTY = new Set<string>();

function HomePage({ tree, ds, startId, kin, onNavigate }: { tree: PublishedTree; ds: Dataset; startId?: string; kin?: KinshipResolver; onNavigate: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const nameOf = useNameOf();
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    if (!query.trim()) return [];
    const out: Individual[] = [];
    for (const indi of ds.individuals.values()) {
      if (nameMatches(nameOf(indi), query)) out.push(indi);
    }
    return out.sort((a, b) => nameOf(a).localeCompare(nameOf(b), i18n.language));
  }, [ds, query, nameOf, i18n.language]);
  const num = (n: number) => n.toLocaleString(i18n.language);

  return (
    <div className="site-home">
      <section className="site-hero">
        <h1>{tree.title || t("site.untitled")}</h1>
        {tree.intro && <p className="site-intro">{tree.intro}</p>}
        <p className="site-counts">
          {t("site.counts", { people: num(ds.individuals.size), families: num(ds.families.size) })}
        </p>
        {startId && ds.individuals.has(startId) && (
          <p className="site-start">
            {t("site.start")}{" "}
            <PersonLink dataset={ds} id={startId} fallback={startId} onNavigate={onNavigate} />
          </p>
        )}
      </section>
      <section className="site-search">
        <label className="site-search-label" htmlFor="site-search">{t("site.search.label")}</label>
        <input
          id="site-search"
          type="search"
          className="tools-search-input site-search-input"
          value={query}
          placeholder={t("site.search.placeholder")}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
        />
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
  );
}

function EventRows({ events, family }: { events: GedEvent[]; family?: boolean }) {
  const { t, i18n } = useTranslation();
  if (!events.length) return null;
  return (
    <dl className="site-events">
      {events.map((e, i) => {
        const label = (e.tag === "EVEN" || e.tag === "FACT") && e.type
          ? customEventLabel(e.type, t, i18n.language)
          : family ? familyEventLabel(e.tag, t) : eventDisplayLabel(e.tag, t);
        const parts = [e.value, e.date && displayDate(e.date), e.place?.raw].filter(Boolean);
        return (
          <div key={i} className="site-event">
            <dt>{label}</dt>
            <dd>
              {parts.join(", ")}
              {e.cause && <span className="site-event-cause"> ({e.cause})</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function PersonPage({ ds, id, living, kin, isStart, onMakeStart, onNavigate, onCharts }: {
  ds: Dataset;
  id: string;
  living: boolean;
  kin?: KinshipResolver;
  isStart: boolean;
  onMakeStart: () => void;
  onNavigate: (id: string) => void;
  onCharts: () => void;
}) {
  const { t } = useTranslation();
  const nameOf = useNameOf();
  const indi = ds.individuals.get(id)!;
  const link = (pid: string | undefined) => pid && ds.individuals.has(pid)
    ? <KinLink ds={ds} id={pid} kin={kin} onNavigate={onNavigate} />
    : null;
  const kinship = isStart ? t("site.person.isStart") : kin?.label(id);
  const parentFams = indi.childOf.map((f) => ds.families.get(f)).filter((f): f is Family => !!f);
  const ownFams = indi.spouseOf.map((f) => ds.families.get(f)).filter((f): f is Family => !!f);
  const siblings = [...new Set(parentFams.flatMap((f) => f.children))].filter((c) => c !== id);

  return (
    <article className="site-person">
      <header className="site-person-head">
        <h2 className={`site-person-name ${sexClass(indi.sex)}`}>{nameOf(indi)}</h2>
        <span className="site-person-years"><YearsText text={lifespanOf(indi)} /></span>
        <div className="site-person-actions">
          {!isStart && (
            <button className="nav-btn" onClick={onMakeStart} title={t("start.chip.makeThis")}>
              <HomeIcon size={16} /> {t("site.person.makeStart")}
            </button>
          )}
          <button className="nav-btn site-charts-btn" onClick={onCharts}>
            <ChartIcon size={16} /> {t("site.person.charts")}
          </button>
        </div>
      </header>
      {kinship && <p className={`person-kinship site-person-kinship ${isStart ? "" : lineageClass(kin?.lineage(id), kin?.direct(id))}`}>{kinship}</p>}
      {living && <p className="site-note">{t("site.person.living")}</p>}
      <EventRows events={indi.events} />

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

      {ownFams.map((f) => {
        const partner = f.husband === id ? f.wife : f.husband;
        return (
          <section key={f.id} className="site-section">
            <h3>{partner ? t("site.person.partner") : t("site.person.family")}</h3>
            {partner && <p className="site-partner">{link(partner)}</p>}
            <EventRows events={f.events} family />
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

      {siblings.length > 0 && (
        <section className="site-section">
          <h3>{t("site.person.siblings", { count: siblings.length })}</h3>
          <ul className="site-person-list">
            {siblings.map((c) => <li key={c}>{link(c)}</li>)}
          </ul>
        </section>
      )}
    </article>
  );
}
