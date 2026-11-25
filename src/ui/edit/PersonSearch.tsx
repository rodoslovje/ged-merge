import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, Individual } from "../../gedcom/types";
import { displayDateText } from "../../gedcom/dateDisplay";
import { defaultPrivacyOptions, livingReason } from "../../tools/privacy";
import { INDEX_SEARCH_SITE, personQuery, searchUrl, SEARCH_SITES, type PersonQuery } from "../../online/searchLinks";
import { GEN_INDEXES, type GenIndex } from "../../online/genIndexes";
import {
  clusterHits,
  contributorList,
  contributorSource,
  contributorUrl,
  type ContributorKind,
  fetchIndexHits,
  hitCiteUrl,
  hitsForComparison,
  indexApiUrl,
  indexPersonUrl,
  rankHits,
  type HitCluster,
  type IndexAnswer,
  type IndexHit,
  type IndexRelative,
  type RankedHit,
  type RankedHits,
} from "../../online/indexSearch";
import { individualFieldRows } from "../../review/fields";
import { foldToken } from "../../match/text";
import { SITE_ICON } from "../../tools/sourceReshape/urls";
import type { FieldChoice, FieldRow } from "../../review/types";
import { useSetSettings, useSettingsSlice } from "../SettingsContext";
import { FieldValue, LinkIcons } from "../FieldValue";
import { SourceRefs } from "../SourceRef";
import { ExternalIcon } from "../icons/ExternalIcon";
import { ChevronIcon } from "../icons/ChevronIcon";

const SETTINGS_KEYS = ["allowLinkFetch", "indexContributor", "indexContributorHr", "indexExact", "searchSites"] as const;

/** The index the hits on show come from — their links and contributor pages point there. */
const IndexSite = createContext<GenIndex>("si");

/** How many people (groups of matched hits) the rail lists. */
const SHOWN = 10;

/** Answers already fetched this session, by API address — returning to a
 *  person does not ask the index again. */
const answered = new Map<string, IndexAnswer>();
const ANSWERED_CAP = 100;
/** Searches on their way, by API address — a rail shown again before the
 *  answer arrives waits for the same request instead of sending another. */
const inflight = new Map<string, Promise<IndexAnswer>>();

function askIndex(query: PersonQuery, own: readonly string[], site: GenIndex): Promise<IndexAnswer> {
  const url = indexApiUrl(query, own, site);
  let pending = inflight.get(url);
  if (!pending) {
    pending = fetchIndexHits(query, own, AbortSignal.timeout(20000), site)
      .then((answer) => {
        if (answered.size >= ANSWERED_CAP) answered.delete(answered.keys().next().value!);
        answered.set(url, answer);
        return answer;
      })
      .finally(() => inflight.delete(url));
    inflight.set(url, pending);
  }
  return pending;
}

type Done = RankedHits & {
  /** The people shown, in ranking order — see {@link clusterHits}. */
  clusters: HitCluster[];
  /** Every hit shown, cluster by cluster: the order the comparison steps through. */
  flat: RankedHit[];
  /** All the hits the index has for the search. */
  total: number;
};

type SearchState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error" }
  | ({ state: "done" } & Done);

function settle(person: Individual, dataset: Dataset, answer: IndexAnswer, own: readonly string[]): Done {
  const ranked = rankHits(person, dataset, answer.hits);
  const clusters = clusterHits(ranked.ranked, own).slice(0, SHOWN);
  return { ...ranked, clusters, flat: clusters.flatMap((c) => c.members), total: answer.total };
}

/** A hit's comparison rows by key — the rows Compare shows, so the list marks
 *  what the table colours. */
type HitRows = Map<string, FieldRow>;

/** The village or town of a place: two files naming the same village to a
 *  different depth ("Petelinje" / "Petelinje, Kranjska") agree. */
function locality(place: string): string {
  return foldToken(place.split(",")[0] ?? "");
}

/** A relative's name without the years a line appends ("Jožef Plut 1871–1920"):
 *  the list compares who, not when. */
function relativeName(line: string): string {
  return foldToken(line.replace(/[\s\d–—\-~?().,/]+$/u, ""));
}

type Mark = { mark: "differs"; mine: string } | { mark: "adds" } | undefined;

function markOf(row: FieldRow | undefined, compare?: (s: string) => string): Mark {
  if (!row) return undefined;
  if (row.state === "incoming-only") return { mark: "adds" };
  if (row.state !== "conflict") return undefined;
  if (compare && compare(row.main) === compare(row.incoming)) return undefined;
  return { mark: "differs", mine: row.main };
}

/** One part of a hit's summary, underlined when it differs from the person
 *  (dotted, the comparison's amber) or is new to them (solid, its green);
 *  agreement stays plain. */
function Marked({ text, mark, shown = (s: string) => s }: { text: string; mark: Mark; shown?: (s: string) => string }) {
  const { t } = useTranslation();
  if (!mark) return <>{text}</>;
  return (
    <span
      className={`person-search-mark ${mark.mark}`}
      title={mark.mark === "differs" ? t("indexSearch.differs", { value: shown(mark.mine) }) : t("indexSearch.adds")}
    >
      {text}
    </span>
  );
}

/** One life event of a hit: symbol, date and place, each part marked. */
function Vital({ symbol, tag, date, place, rows }: { symbol: string; tag: string; date?: string; place?: string; rows?: HitRows }) {
  if (!date && !place) return null;
  return (
    <div className="person-search-hit-fact">
      {symbol}{" "}
      {date && <Marked text={displayDateText(date)} mark={markOf(rows?.get(`${tag}.date`))} shown={displayDateText} />}
      {date && place && ", "}
      {place && <Marked text={place} mark={markOf(rows?.get(`${tag}.place`), locality)} />}
    </div>
  );
}

/** A hit's parents and partners, each name marked against the person's. */
function Relatives({ hit, rows }: { hit: IndexHit; rows?: HitRows }) {
  const named = (r: IndexRelative) => [r.name, r.surname].filter(Boolean).join(" ");
  const parents = (hit.parents_list ?? []).filter((r) => named(r));
  const partners = (hit.partners_list ?? []).filter((r) => named(r));
  if (!parents.length && !partners.length) return null;
  const partnerRows = rows ? [...rows.values()].filter((r) => r.key.startsWith("fam.") && r.key.endsWith(".partner")) : [];
  const parts = [
    ...parents.map((r, i) => {
      // The index lists the father first; its sex column settles it when given.
      const slot = r.sex?.toLowerCase() === "f" || (r.sex?.toLowerCase() !== "m" && i === 1) ? "mother" : "father";
      return { name: named(r), row: rows?.get(slot) };
    }),
    ...partners.map((r) => ({
      name: named(r),
      row: partnerRows.find((p) => relativeName(p.incoming).includes(foldToken(named(r)))),
    })),
  ];
  return (
    <div className="person-search-hit-relatives">
      {parts.map(({ name, row }, i) => (
        <span key={i}>
          {i > 0 && " · "}
          <Marked text={name} mark={markOf(row, relativeName)} />
        </span>
      ))}
    </div>
  );
}

/** The icon of each non-tree source — the one the app shows for that site's links. */
const KIND_ICON: Record<Exclude<ContributorKind, "tree">, string> = {
  matricula: SITE_ICON.matricula,
  geneanet: SITE_ICON.geneanet,
  military: SITE_ICON.sistory,
};

/** A contributor as the reader knows them: the genealogist's name, with an
 *  icon (and its tip) for records that are not their tree — "Markovič-matricula"
 *  shows as ⛪ Markovič. With `link`, the name opens their page on the index. */
function Contributor({ contributor, className, link }: { contributor: string; className?: string; link?: boolean }) {
  const { t } = useTranslation();
  const site = useContext(IndexSite);
  const { name, kind } = contributorSource(contributor);
  const label = kind === "tree" ? undefined : t(`indexSearch.kind.${kind}`);
  const title = [label && `${label} — ${name}`, link && t("indexSearch.contributorPage")].filter(Boolean).join("\n") || undefined;
  const body = (
    <>
      {label && <span className="person-search-kind" role="img" aria-label={label}>{KIND_ICON[kind as Exclude<ContributorKind, "tree">]}</span>}
      {name}
    </>
  );
  return link ? (
    <a className={`${className ?? ""} person-search-contributor-link`} href={contributorUrl(contributor, site)} target="_blank" rel="noopener noreferrer" title={title}>
      {body}
    </a>
  ) : (
    <span className={className} title={title}>{body}</span>
  );
}

/** One contributor can hold several records of the same person (two entries
 *  of one grave, a baptism and a burial): list each contributor once, with
 *  its records in ranking order. */
function byContributor(members: readonly RankedHit[]): [string, RankedHit[]][] {
  const groups = new Map<string, RankedHit[]>();
  for (const m of members) {
    const list = groups.get(m.hit.contributor);
    if (list) list.push(m);
    else groups.set(m.hit.contributor, [m]);
  }
  return [...groups];
}

function hitName(hit: IndexHit): string {
  return [hit.name, hit.surname].filter(Boolean).join(" ");
}

/** Whether a row brings sources or links of the index's own. */
function bringsSources(row: FieldRow): boolean {
  return !!(row.incomingSources?.length || row.incomingLinkIcons?.length);
}

/**
 * The rows a comparison shows: what the index agrees with, contradicts or
 * adds. What only the person has (their own sources, events the index never
 * records) is left out — it says nothing about the hit; a sources row stays
 * when the index brings a link of its own (a Matricula page, a grave). A group
 * heading stays only over rows that do.
 */
function comparedRows(rows: FieldRow[]): FieldRow[] {
  const out: FieldRow[] = [];
  let heading: FieldRow | undefined;
  for (const row of rows) {
    if (row.isGroupHeader) {
      heading = row;
      continue;
    }
    if (row.state === "main-only") continue;
    const hasSources = !!(row.mainSources || row.incomingSources || row.mainLinkIcons || row.incomingLinkIcons);
    if (hasSources && !bringsSources(row)) continue;
    if (heading) {
      out.push(heading);
      heading = undefined;
    }
    out.push(row);
  }
  return out;
}

/** A row the reader can take into the person: one the index adds to, or
 *  differs on. Relatives are people, not values — they stay for reading. */
function copyable(row: FieldRow): boolean {
  if (row.isGroupHeader || row.relatives) return false;
  if (row.key === "father" || row.key === "mother" || row.key.startsWith("fam.")) return false;
  return row.state === "incoming-only" || row.state === "conflict";
}

/** Each heading's copyable rows, so one tick takes a whole event. */
function rowsUnder(rows: FieldRow[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let heading: string | undefined;
  for (const row of rows) {
    if (row.isGroupHeader) {
      heading = row.key;
      out.set(heading, []);
    } else if (heading && copyable(row)) out.get(heading)!.push(row.key);
  }
  return out;
}

/** The cells of one value: plain text, or the sources and links it carries. */
function RowValue({ row, side }: { row: FieldRow; side: "main" | "incoming" }) {
  const { t } = useTranslation();
  const mine = side === "main";
  const sources = mine ? row.mainSources : row.incomingSources;
  const icons = mine ? row.mainLinkIcons : row.incomingLinkIcons;
  const other = mine ? row.incomingLinkIcons : row.mainLinkIcons;
  if (row.mainSources || row.incomingSources || row.mainLinkIcons || row.incomingLinkIcons) {
    return (
      <>
        <SourceRefs t={t} mainSources={sources} {...(mine ? {} : { compareAgainst: row.mainSources })} />
        {icons?.length ? <LinkIcons urls={icons} otherUrls={other} /> : null}
      </>
    );
  }
  return mine ? (
    <FieldValue text={row.main} links={row.mainLinks} linkIcons={row.mainLinkIcons} />
  ) : (
    <FieldValue
      text={row.incoming}
      links={row.incomingLinks}
      otherLinks={row.mainLinks}
      linkIcons={row.incomingLinkIcons}
      otherLinkIcons={row.mainLinkIcons}
    />
  );
}

/** Take the ticked rows of a hit into the person; `citeUrl` cites the hit on
 *  every event the copy changes. */
type CopyFromHit = (
  hit: Individual,
  hitDs: Dataset,
  fields: Record<string, FieldChoice>,
  citeUrl: string | undefined,
) => void;

/** One hit set against the person, field by field, as Merge would compare
 *  them — with a tick on each row the index adds or differs on, to take it
 *  into the person. */
function HitComparison({
  person,
  dataset,
  hitsDs,
  ranked,
  index,
  onIndex,
  onBack,
  onCite,
  onCopy,
}: {
  person: Individual;
  dataset: Dataset;
  hitsDs: Dataset;
  ranked: RankedHit[];
  index: number;
  onIndex: (i: number) => void;
  onBack: () => void;
  onCite: (url: string) => void;
  onCopy: CopyFromHit;
}) {
  const { t } = useTranslation();
  const { hit, id, score } = ranked[index];
  const normalized = useMemo(() => hitsForComparison(hitsDs, dataset), [hitsDs, dataset]);
  /** Bumped after a copy: the person changed in place, so the rows are read again. */
  const [copies, setCopies] = useState(0);
  const rows = useMemo(() => {
    const indi = normalized.individuals.get(id);
    return indi ? comparedRows(individualFieldRows(t, person, indi, dataset, normalized)) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalized, id, person, dataset, t, copies]);
  const groups = useMemo(() => rowsUnder(rows), [rows]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [cite, setCite] = useState(true);
  // Another hit, or the rows read again after a copy: nothing stays ticked.
  useEffect(() => setPicked(new Set()), [id, copies]);

  const site = useContext(IndexSite);
  const url = indexPersonUrl(hit, site);
  const citeUrl = hitCiteUrl(hit, site);
  const toggle = (keys: string[], on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  const allNew = rows.filter((r) => copyable(r) && r.state === "incoming-only").map((r) => r.key);
  const copy = () => {
    const indi = normalized.individuals.get(id);
    if (!indi || !picked.size) return;
    const fields: Record<string, FieldChoice> = {};
    for (const key of picked) fields[key] = "incoming";
    onCopy(indi, normalized, fields, cite ? citeUrl : undefined);
    setCopies((n) => n + 1);
  };

  return (
    <div className="person-search-compare">
      <div className="person-search-compare-nav">
        <button type="button" className="tools-issue-link" onClick={onBack}>
          {t("indexSearch.back")}
        </button>
        <span className="person-search-compare-step">
          <button
            type="button"
            className="person-search-step-btn"
            disabled={index === 0}
            aria-label={t("indexSearch.prev")}
            title={t("indexSearch.prev")}
            onClick={() => onIndex(index - 1)}
          >
            <ChevronIcon dir="left" size={14} />
          </button>
          <span className="gm-data">{t("indexSearch.position", { n: index + 1, total: ranked.length })}</span>
          <button
            type="button"
            className="person-search-step-btn"
            disabled={index === ranked.length - 1}
            aria-label={t("indexSearch.next")}
            title={t("indexSearch.next")}
            onClick={() => onIndex(index + 1)}
          >
            <ChevronIcon dir="right" size={14} />
          </button>
        </span>
      </div>
      <div className="person-search-hit-name">
        <span className="person-search-score" title={t("indexSearch.scoreTip")}>{Math.round(score)}</span>
        <span>{hitName(hit)}</span>
        <Contributor contributor={hit.contributor} className="person-search-contributor" link />
      </div>
      {allNew.length > 0 && (
        <button type="button" className="tools-issue-link person-search-pick-new" onClick={() => toggle(allNew, true)}>
          {t("indexSearch.pickNew")}
        </button>
      )}
      <table className="person-search-table">
        <thead>
          <tr>
            <th className="person-search-pick" />
            <th />
            <th>{t("indexSearch.thisPerson")}</th>
            <th>{t(`indexSearch.site.${INDEX_SEARCH_SITE[site]}`)}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            if (row.isGroupHeader) {
              const keys = groups.get(row.key) ?? [];
              const on = keys.length > 0 && keys.every((k) => picked.has(k));
              return (
                <tr key={row.key} className="person-search-group">
                  <td className="person-search-pick">
                    {keys.length > 0 && (
                      <input
                        type="checkbox"
                        checked={on}
                        aria-label={t("indexSearch.pickRow", { field: row.displayLabel ?? row.label })}
                        onChange={(e) => toggle(keys, e.target.checked)}
                      />
                    )}
                  </td>
                  <th colSpan={3}>{row.displayLabel ?? row.label}</th>
                </tr>
              );
            }
            const label = row.displayLabel ?? row.label;
            return (
              <tr key={row.key} className={`field ${row.state}`}>
                <td className="person-search-pick">
                  {copyable(row) && (
                    <input
                      type="checkbox"
                      checked={picked.has(row.key)}
                      aria-label={t("indexSearch.pickRow", { field: label })}
                      title={t(row.state === "conflict" ? "indexSearch.pickReplace" : "indexSearch.pickAdd")}
                      onChange={(e) => toggle([row.key], e.target.checked)}
                    />
                  )}
                </td>
                <td className="f-label">{label}</td>
                <td className="f-val gm-data" title={row.mainTitle}>
                  <RowValue row={row} side="main" />
                </td>
                <td className="f-val gm-data" title={row.incomingTitle}>
                  <RowValue row={row} side="incoming" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="person-search-copy">
        <label className="person-search-exact">
          <input type="checkbox" checked={cite} onChange={(e) => setCite(e.target.checked)} />
          {t("indexSearch.citeCopied")}
        </label>
        <button type="button" className="person-search-copy-btn" disabled={!picked.size} onClick={copy}>
          {t("indexSearch.copy", { n: picked.size })}
        </button>
      </div>
      <div className="person-search-hit-foot">
        <a className="tools-issue-link" href={url} target="_blank" rel="noopener noreferrer">
          {t("indexSearch.open")}
        </a>
        <button type="button" className="tools-issue-link" onClick={() => onCite(citeUrl)}>
          {t("indexSearch.cite")}
        </button>
      </div>
    </div>
  );
}

/**
 * One genealogical index's own hits for the person, asked for as soon as the
 * rail shows them, ranked by the match score against them. A hit opens into
 * a field-by-field comparison with the person, stepping from hit to hit, and
 * its index page can be cited as a source.
 */
function IndexResults({
  site,
  person,
  dataset,
  query,
  living,
  hidden,
  onOpen,
  onCite,
  onCopy,
}: {
  site: GenIndex;
  person: Individual;
  dataset: Dataset;
  query: PersonQuery;
  living: boolean;
  /** Another index's comparison has the rail. */
  hidden: boolean;
  /** Whether this index's comparison is open, as it changes. */
  onOpen: (open: boolean) => void;
  onCite: (url: string) => void;
  onCopy: CopyFromHit;
}) {
  const { t } = useTranslation();
  const settings = useSettingsSlice(SETTINGS_KEYS);
  const { allowLinkFetch, indexExact } = settings;
  const contributors = site === "hr" ? settings.indexContributorHr : settings.indexContributor;
  const setSettings = useSetSettings();
  const own = useMemo(() => contributorList(contributors), [contributors]);
  const ownKey = own.join(",");
  const [search, setSearch] = useState<SearchState>(() => {
    const cached = answered.get(indexApiUrl(query, own, site));
    return cached ? { state: "done", ...settle(person, dataset, cached, own) } : { state: "idle" };
  });
  const [attempt, setAttempt] = useState(0);
  /** The hit open in the comparison, by its place in `flat`. */
  const [comparing, setComparing] = useState<number | null>(null);

  const searchable = allowLinkFetch && !living;
  // Ask the index as soon as it may be asked: on showing the person, on the
  // switch being turned on, on a changed own-tree name or exact choice, and
  // again on "Try again". An answer already held (the cache) leaves nothing to ask.
  useEffect(() => {
    if (!searchable) return;
    const cached = answered.get(indexApiUrl(query, own, site));
    if (cached) {
      setSearch({ state: "done", ...settle(person, dataset, cached, own) });
      return;
    }
    let cancelled = false;
    setSearch({ state: "loading" });
    setComparing(null);
    askIndex(query, own, site)
      .then((answer) => {
        if (!cancelled) setSearch({ state: "done", ...settle(person, dataset, answer, own) });
      })
      .catch(() => {
        if (!cancelled) setSearch({ state: "error" });
      });
    return () => {
      cancelled = true;
      // Interrupted (the switch turned off): ask again when it is back on.
      setSearch((s) => (s.state === "loading" ? { state: "idle" } : s));
    };
    // Person and dataset are fixed per mount (the rail is keyed by person);
    // the query changes only with the exact choice; `attempt` re-runs the
    // search after an error.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchable, attempt, ownKey, indexExact]);

  const retry = () => {
    setSearch({ state: "idle" });
    setAttempt((n) => n + 1);
  };

  const flat = search.state === "done" ? search.flat : [];
  /** Each listed person's comparison rows, by hit id: the marks in the list
   *  are what Compare colours. */
  const listRows = useMemo(() => {
    const out = new Map<number, HitRows>();
    if (search.state !== "done" || !search.clusters.length) return out;
    const hits = hitsForComparison(search.ds, dataset);
    for (const { members } of search.clusters) {
      const indi = hits.individuals.get(members[0].id);
      if (indi) out.set(members[0].hit.id, new Map(individualFieldRows(t, person, indi, dataset, hits).map((r) => [r.key, r])));
    }
    return out;
  }, [search, dataset, person, t]);
  const open = search.state === "done" && searchable && comparing !== null && comparing < flat.length;
  useEffect(() => onOpen(open), [open, onOpen]);

  return (
    <IndexSite.Provider value={site}>
      <section className="person-search-index" hidden={hidden}>
        <div className="person-search-index-head">
          <h3 className="person-search-index-title">
            {t(`indexSearch.site.${INDEX_SEARCH_SITE[site]}`)}
            {search.state === "done" && searchable && <>{" "}<span className="edit-wider-count gm-data">{search.total}</span></>}
          </h3>
          {searchable && (
            // The index's own "Exact / Approximate" choice, as its readers know
            // it; approximate is this search's default, so it is the box.
            <label className="person-search-exact" title={t("indexSearch.approximate.hint")}>
              <input
                type="checkbox"
                checked={!indexExact}
                onChange={(e) => {
                  setComparing(null);
                  setSettings({ indexExact: !e.target.checked });
                }}
              />
              {t("indexSearch.approximate")}
            </label>
          )}
        </div>
        {living ? (
          <p className="person-search-note">{t("indexSearch.living")}</p>
        ) : !allowLinkFetch ? (
          <p className="person-search-note">{t("indexSearch.fetchOff", { setting: t("settings.links.fetch") })}</p>
        ) : search.state === "loading" || search.state === "idle" ? (
          <p className="person-search-note">{t("indexSearch.searching")}</p>
        ) : search.state === "error" ? (
          <p className="person-search-note">
            {t("indexSearch.error")}{" "}
            <button type="button" className="tools-issue-link" onClick={retry}>{t("indexSearch.retry")}</button>
          </p>
        ) : !flat.length ? (
          <p className="person-search-note">{t("indexSearch.none")}</p>
        ) : open ? (
          <HitComparison
            person={person}
            dataset={dataset}
            hitsDs={search.ds}
            ranked={flat}
            index={comparing}
            onIndex={setComparing}
            onBack={() => setComparing(null)}
            onCite={onCite}
            onCopy={onCopy}
          />
        ) : (
          <>
            <ol className="person-search-hits">
              {search.clusters.map((cluster) => {
                const [{ hit, score }, ...others] = cluster.members;
                const at = (r: RankedHit) => flat.indexOf(r);
                const rows = listRows.get(hit.id);
                // A birth the index gives as a baptism alone shows (and compares) as one.
                const born = hit.date_of_birth || hit.place_of_birth;
                return (
                  <li key={hit.id} className="person-search-hit">
                    <div className="person-search-hit-name">
                      <span className="person-search-score" title={t("indexSearch.scoreTip")}>{Math.round(score)}</span>
                      <button type="button" className="person-search-hit-open" onClick={() => setComparing(at(cluster.members[0]))}>
                        {hitName(hit)}
                      </button>
                    </div>
                    {cluster.inOwnTree && <div className="person-search-own">{t("indexSearch.inOwnTree")}</div>}
                    <Vital
                      symbol="*"
                      tag={born ? "BIRT" : "CHR"}
                      date={born ? hit.date_of_birth : hit.date_of_baptism}
                      place={born ? hit.place_of_birth : hit.place_of_baptism}
                      rows={rows}
                    />
                    <Vital symbol="†" tag="DEAT" date={hit.date_of_death} place={hit.place_of_death} rows={rows} />
                    <Vital symbol="⚰" tag="BURI" date={hit.date_of_burial} place={hit.place_of_burial} rows={rows} />
                    <Relatives hit={hit} rows={rows} />
                    {(others.length > 0 || cluster.alsoIn.length > 0) && (
                      <div className="person-search-also">
                        {t("indexSearch.alsoIn")}{" "}
                        {byContributor(others).map(([contributor, records], j) => (
                          <span key={contributor}>
                            {j > 0 && " · "}
                            <button
                              type="button"
                              className="tools-issue-link"
                              title={t("indexSearch.compareThis")}
                              onClick={() => setComparing(at(records[0]))}
                            >
                              <Contributor contributor={contributor} />
                              {records.length > 1 && (
                                <span className="person-search-times" title={t("indexSearch.records", { n: records.length })}>
                                  {` ×${records.length}`}
                                </span>
                              )}
                            </button>
                          </span>
                        ))}
                        {cluster.alsoIn.map((c, j) => (
                          <span key={c}>
                            {(others.length > 0 || j > 0) && " · "}
                            <Contributor contributor={c} link />
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="person-search-hit-foot">
                      <Contributor contributor={hit.contributor} className="person-search-contributor" link />
                      <button type="button" className="tools-issue-link" onClick={() => setComparing(at(cluster.members[0]))}>
                        {t("indexSearch.compare")}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
            {search.total > search.ranked.length && (
              <p className="person-search-note">{t("indexSearch.more", { total: search.total, shown: search.ranked.length })}</p>
            )}
          </>
        )}
      </section>
    </IndexSite.Provider>
  );
}

/**
 * The Edit view's search rail, in the Relatives rail's place: prefilled
 * search pages of the sites switched on in Settings (the Slovenian and
 * Croatian indexes, FamilySearch, Geni, WikiTree, MyHeritage) for the person open in
 * Edit, and — behind the "Look up details online" switch — each switched-on
 * index's own hits ({@link IndexResults}).
 *
 * Keyed by person, so moving to another person starts a fresh search.
 */
export function PersonSearch({
  person,
  dataset,
  onCite,
  onCopy,
}: {
  person: Individual;
  dataset: Dataset;
  /** Open Add source for this person with the hit's index link in it. */
  onCite: (url: string) => void;
  /** Take a hit's ticked rows into this person. */
  onCopy: CopyFromHit;
}) {
  const { t } = useTranslation();
  const { indexExact, searchSites } = useSettingsSlice(SETTINGS_KEYS);
  const query = useMemo(() => {
    const q = personQuery(person, dataset);
    return q && indexExact ? { ...q, exact: true } : q;
  }, [person, dataset, indexExact]);
  const living = useMemo(
    () => !!livingReason(person, dataset, defaultPrivacyOptions(), new Date().getFullYear()),
    [person, dataset],
  );
  const sites = SEARCH_SITES.filter((s) => searchSites[s]);
  const indexes = GEN_INDEXES.filter((i) => searchSites[INDEX_SEARCH_SITE[i]]);
  /** The index whose comparison has the rail, if any. */
  const [comparingIn, setComparingIn] = useState<GenIndex | null>(null);
  const onOpen = useMemo(
    () =>
      Object.fromEntries(
        GEN_INDEXES.map((i) => [i, (open: boolean) => setComparingIn((c) => (open ? i : c === i ? null : c))]),
      ) as Record<GenIndex, (open: boolean) => void>,
    [],
  );
  const open = comparingIn !== null && indexes.includes(comparingIn);

  return (
    <aside
      className={`edit-wider person-search${open ? " comparing" : ""}`}
      id="edit-search"
      aria-labelledby="edit-search-title"
    >
      <div className="edit-wider-head">
        <div className="edit-wider-title">
          <strong id="edit-search-title">{t("indexSearch.title")}</strong>
        </div>
        {!query ? (
          <p className="person-search-note">{t("indexSearch.noName")}</p>
        ) : sites.length > 0 ? (
          <div className="person-search-sites">
            <span className="person-search-label">{t("indexSearch.searchOn")}</span>
            {sites.map((site) => (
              <a key={site} className="person-search-site" href={searchUrl(site, query)} target="_blank" rel="noopener noreferrer">
                {t(`indexSearch.site.${site}`)} <ExternalIcon size={11} />
              </a>
            ))}
          </div>
        ) : (
          <p className="person-search-note">{t("indexSearch.noSites")}</p>
        )}
      </div>
      {query && indexes.length > 0 && (
        <div className="edit-wider-body">
          {indexes.map((i) => (
            <IndexResults
              key={i}
              site={i}
              person={person}
              dataset={dataset}
              query={query}
              living={living}
              hidden={open && comparingIn !== i}
              onOpen={onOpen[i]}
              onCite={onCite}
              onCopy={onCopy}
            />
          ))}
        </div>
      )}
    </aside>
  );
}
