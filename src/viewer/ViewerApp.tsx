import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { sexClass } from "../ui/sex";
import { ChartIcon } from "../ui/icons/ChartIcon";
import { HomeIcon } from "../ui/icons/HomeIcon";
import { SearchIcon } from "../ui/icons/SearchIcon";
import { StatsIcon } from "../ui/icons/StatsIcon";
import { LogoMark } from "../ui/icons/LogoMark";
import { lifespanApproxOf, lifespanOf } from "../gedcom/lifespan";
import { lifespanAge } from "../gedcom/age";
import { lifespanLine } from "../chart/nodeDisplay";
import { displayDateText } from "../gedcom/dateDisplay";
import { customEventLabel, eventDisplayLabel, familyEventLabel } from "../gedcom/eventTags";
import { LANGUAGE_FLAGS, LANGUAGE_NAMES, SUPPORTED_LANGUAGES } from "../locales/i18n";
import { StartPersonSelector } from "../ui/StartPersonSelector";
import { useDatasetDerivations } from "../ui/DatasetDerivations";
import { lineageClass, type KinshipResolver } from "../match/kinship";
import { useTheme } from "../ui/useTheme";
import { nameMatches, parseRoute, routeHash, startRoute, type Route } from "./route";
import { chartViewOf, chartViewWords } from "./chartRoute";
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


/** The visitor's own start person, kept in their browser. */
const START_KEY = "gedmerge-site.start";
const KINSHIP_KEYS = ["showKinship"] as const;
const AGE_KEYS = ["showAge"] as const;

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
  const setSettings = useSetSettings();
  const { settings: chartSettings, setKind, set: setChartSettings } = useChartSettings();
  // Ancestors, descendants or both: the site keeps it, so the address can.
  const [direction, setDirection] = useState<ChartDirection>("both");
  // Each view of each person's chart has its own address
  // (`#/c/<person>/<kind>/<view words>`, see `chartRoute.ts`): an address names
  // the chart and how it is drawn, and changing either updates the address.
  // `applied` is the last address put into effect, so a change made in the hub
  // is not undone by the address it is still on.
  const applied = useRef<string | undefined>(undefined);
  const shownWords = chartViewWords(chartSettings.kind, chartSettings, direction);
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
      awaiting.current = [route.kind, ...chartViewWords(route.kind, { ...chartSettings, ...view.settings }, view.direction)].join("/");
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
  // The site has no Settings page: people are shown as the author chose when
  // publishing (names, dates, ages, kinship), and the map may load its tiles.
  useEffect(() => {
    setSettings({ ...DEFAULT_SITE_DISPLAY, ...tree.display, allowMapTiles: true, showXref: false });
  }, [setSettings, tree.display]);
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
  // Kinship labels follow the author's display choice, as everywhere in the app.
  const { showKinship } = useSettingsSlice(KINSHIP_KEYS);
  const kin = startXref && showKinship ? derivations?.kinship(startXref) : undefined;
  const pub = useMemo<PubIndex>(() => ({
    people: new Map(tree.people.map((p) => [xrefOf(p.id), p])),
    families: new Map(tree.families.map((f) => [xrefOf(f.id), f])),
  }), [tree]);
  const [relationFrom, setRelationFrom] = useState<string | undefined>();
  const openPerson = (xref: string) => go({ page: "person", id: pubId(xref) });
  // A person's charts, drawn as the charts are now. Re-rooting on the person
  // already shown (the hub does so as it opens) leaves the address alone.
  const openCharts = (xref: string) => {
    if (route.page === "charts" && xrefOf(route.id) === xref) return;
    go({ page: "charts", id: pubId(xref), kind: chartSettings.kind, view: shownWords.length ? shownWords : undefined });
  };
  // The header's search: the front page's search box, focused. A counter, so
  // a second press on the front page focuses it again.
  const [searchNonce, setSearchNonce] = useState(0);
  const openSearch = () => {
    if (route.page !== "home") go({ page: "home" });
    setSearchNonce((n) => n + 1);
  };

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
          <a className={`nav-btn${route.page === "stats" ? " active" : ""}`} href="#/stats">
            <StatsIcon size={16} /> {t("site.nav.stats")}
          </a>
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
          <button
            type="button"
            className="nav-btn icon-only site-toggle site-theme"
            onClick={() => changeThemeMode(otherTheme)}
            title={t(`site.theme.${otherTheme}`)}
            aria-label={t(`site.theme.${otherTheme}`)}
          >
            {otherTheme === "light" ? "☀" : "☾"}
          </button>
          <button
            type="button"
            className="nav-btn icon-only site-toggle site-lang"
            onClick={() => void i18n.changeLanguage(otherLang)}
            title={LANGUAGE_NAMES[otherLang]}
            aria-label={LANGUAGE_NAMES[otherLang]}
            lang={otherLang}
          >
            {LANGUAGE_FLAGS[otherLang]}
          </button>
          <button
            type="button"
            className="nav-btn icon-only site-toggle site-search-btn"
            onClick={openSearch}
            title={t("site.search.label")}
            aria-label={t("site.search.label")}
          >
            <SearchIcon size={16} />
          </button>
        </div>
      </div>
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
          relationFromId={relationFrom}
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
    body = <HomePage tree={tree} ds={ds} startId={startXref} kin={kin} focusNonce={searchNonce} onNavigate={openPerson} />;
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

function HomePage({ tree, ds, startId, kin, focusNonce, onNavigate }: {
  tree: PublishedTree;
  ds: Dataset;
  startId?: string;
  kin?: KinshipResolver;
  /** Bumped by the header's search button: focus the search box. */
  focusNonce: number;
  onNavigate: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const nameOf = useNameOf();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusNonce) searchRef.current?.focus();
  }, [focusNonce]);
  const results = useMemo(() => {
    if (!query.trim()) return [];
    const out: Individual[] = [];
    for (const indi of ds.individuals.values()) {
      if (nameMatches(nameOf(indi), query)) out.push(indi);
    }
    return out.sort((a, b) => nameOf(a).localeCompare(nameOf(b), i18n.language));
  }, [ds, query, nameOf, i18n.language]);
  const num = (n: number) => n.toLocaleString(i18n.language);
  // The author's words in the reader's language, else in the other one.
  const intro = tree.intro?.[i18n.language] ?? Object.values(tree.intro ?? {})[0];

  return (
    <div className="site-home">
      <section className="site-hero">
        <h1>{tree.title || t("site.untitled")}</h1>
        {intro && <p className="site-intro">{intro}</p>}
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
          ref={searchRef}
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

/** One source citation: the source, the cited page, linked where it can be. */
function SourceLine({ s }: { s: PubSource }) {
  const text = [s.title, s.page].filter(Boolean).join(", ") || s.url;
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
function EventRows({ events, family }: { events: PubEvent[] | undefined; family?: boolean }) {
  const { t, i18n } = useTranslation();
  if (!events?.length) return null;
  return (
    <dl className="site-events">
      {events.map((e, i) => {
        const label = (e.tag === "EVEN" || e.tag === "FACT") && e.type
          ? customEventLabel(e.type, t, i18n.language)
          : family ? familyEventLabel(e.tag, t) : eventDisplayLabel(e.tag, t);
        const parts = [e.value, e.date && displayDateText(e.date), e.address, e.place].filter(Boolean);
        return (
          <div key={i} className="site-event">
            <dt>{label}</dt>
            <dd>
              {parts.join(", ")}
              {e.cause && <span className="site-event-cause"> ({e.cause})</span>}
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

function PersonPage({ ds, pub, id, kin, isStart, onMakeStart, onNavigate, onCharts }: {
  ds: Dataset;
  /** The published records, by dataset id: what the page shows of each. */
  pub: PubIndex;
  id: string;
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
  const { showAge } = useSettingsSlice(AGE_KEYS);
  const parentFams = indi.childOf.map((f) => ds.families.get(f)).filter((f): f is Family => !!f);
  const ownFams = indi.spouseOf.map((f) => ds.families.get(f)).filter((f): f is Family => !!f);
  const siblings = [...new Set(parentFams.flatMap((f) => f.children))].filter((c) => c !== id);
  const person = pub.people.get(id);

  return (
    <article className="site-person">
      <header className="site-person-head">
        <h2 className={`site-person-name ${sexClass(indi.sex)}`}>{nameOf(indi)}</h2>
        <span className="site-person-years">
          <YearsText text={lifespanLine({ showLifespan: true, showAge }, { years: lifespanOf(indi), age: lifespanAge(indi) }) ?? ""} approx={lifespanApproxOf(indi)} />
        </span>
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
      {person?.living && <p className="site-note">{t("site.person.living")}</p>}
      <EventRows events={person?.events} />
      <RecordExtras notes={person?.notes} sources={person?.sources} />

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
            <EventRows events={pub.families.get(f.id)?.events} family />
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
