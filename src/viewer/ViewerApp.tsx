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
import { lifespanOf } from "../gedcom/lifespan";
import { displayDate } from "../gedcom/dateDisplay";
import { customEventLabel, eventDisplayLabel, familyEventLabel } from "../gedcom/eventTags";
import { SUPPORTED_LANGUAGES } from "../locales/i18n";
import { nameMatches, parseRoute, routeHash, type Route } from "./route";

/** Search results listed at most; the reader narrows the query for more. */
const SEARCH_LIMIT = 100;

function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const onHash = () => {
      setRoute(parseRoute(location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return [route, (r) => { location.hash = routeHash(r); }];
}

export function ViewerApp({ tree, ds }: { tree: PublishedTree; ds: Dataset }) {
  const { t, i18n } = useTranslation();
  const [route, go] = useRoute();
  const setSettings = useSetSettings();
  const { setKind } = useChartSettings();
  // The site has no Settings page: dates read in words, in the reader's
  // language, and the map may load its tiles — the author chose to publish.
  useEffect(() => { setSettings({ dateDisplay: "words", allowMapTiles: true, showXref: false }); }, [setSettings]);
  useEffect(() => { document.title = tree.title || t("site.untitled"); }, [tree.title, t]);

  const startXref = tree.start ? xrefOf(tree.start) : undefined;
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
            <a className={`nav-btn${route.page === "charts" ? " active" : ""}`} href={routeHash({ page: "charts", id: tree.start! })}>
              <ChartIcon size={16} /> {t("site.nav.charts")}
            </a>
          )}
          <a className={`nav-btn${route.page === "stats" ? " active" : ""}`} href="#/stats">{t("site.nav.stats")}</a>
        </nav>
        <div className="site-lang" role="group" aria-label={t("site.language")}>
          {SUPPORTED_LANGUAGES.map((lng) => (
            <button
              key={lng}
              className={`nav-btn${i18n.language === lng ? " active" : ""}`}
              aria-pressed={i18n.language === lng}
              onClick={() => void i18n.changeLanguage(lng)}
            >
              {lng.toUpperCase()}
            </button>
          ))}
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
    body = <PersonPage ds={ds} id={id} living={living.has(id)} onNavigate={openPerson} onCharts={() => openCharts(id)} />;
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
    body = <HomePage tree={tree} ds={ds} startId={startXref} onNavigate={openPerson} />;
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

function HomePage({ tree, ds, startId, onNavigate }: { tree: PublishedTree; ds: Dataset; startId?: string; onNavigate: (id: string) => void }) {
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
                  <PersonLink dataset={ds} id={indi.id} fallback={indi.id} onNavigate={onNavigate} />
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

function PersonPage({ ds, id, living, onNavigate, onCharts }: {
  ds: Dataset;
  id: string;
  living: boolean;
  onNavigate: (id: string) => void;
  onCharts: () => void;
}) {
  const { t } = useTranslation();
  const nameOf = useNameOf();
  const indi = ds.individuals.get(id)!;
  const link = (pid: string | undefined) => pid && ds.individuals.has(pid)
    ? <PersonLink dataset={ds} id={pid} fallback={pid} onNavigate={onNavigate} />
    : null;
  const parentFams = indi.childOf.map((f) => ds.families.get(f)).filter((f): f is Family => !!f);
  const ownFams = indi.spouseOf.map((f) => ds.families.get(f)).filter((f): f is Family => !!f);
  const siblings = [...new Set(parentFams.flatMap((f) => f.children))].filter((c) => c !== id);

  return (
    <article className="site-person">
      <header className="site-person-head">
        <h2 className={`site-person-name ${sexClass(indi.sex)}`}>{nameOf(indi)}</h2>
        <span className="site-person-years"><YearsText text={lifespanOf(indi)} /></span>
        <button className="nav-btn site-charts-btn" onClick={onCharts}>
          <ChartIcon size={16} /> {t("site.person.charts")}
        </button>
      </header>
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
