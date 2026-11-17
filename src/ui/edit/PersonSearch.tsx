import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, Individual } from "../../gedcom/types";
import { displayDateText } from "../../gedcom/dateDisplay";
import { defaultPrivacyOptions, livingReason } from "../../tools/privacy";
import { personQuery, searchUrl, SEARCH_SITES, type PersonQuery } from "../../online/searchLinks";
import {
  clusterHits,
  contributorList,
  contributorSource,
  contributorUrl,
  type ContributorKind,
  fetchIndexHits,
  hitsForComparison,
  indexApiUrl,
  indexPersonUrl,
  rankHits,
  type HitCluster,
  type IndexAnswer,
  type IndexHit,
  type RankedHit,
  type RankedHits,
} from "../../online/indexSearch";
import { individualFieldRows } from "../../review/fields";
import { SITE_ICON } from "../../tools/sourceReshape/urls";
import type { FieldRow } from "../../review/types";
import { useSetSettings, useSettingsSlice } from "../SettingsContext";
import { FieldValue } from "../FieldValue";
import { ExternalIcon } from "../icons/ExternalIcon";
import { ChevronIcon } from "../icons/ChevronIcon";

const SETTINGS_KEYS = ["allowLinkFetch", "indexContributor", "indexExact"] as const;

/** How many people (groups of matched hits) the rail lists. */
const SHOWN = 10;

/** Answers already fetched this session, by API address — returning to a
 *  person does not ask the index again. */
const answered = new Map<string, IndexAnswer>();
const ANSWERED_CAP = 100;
/** Searches on their way, by API address — a rail shown again before the
 *  answer arrives waits for the same request instead of sending another. */
const inflight = new Map<string, Promise<IndexAnswer>>();

function askIndex(query: PersonQuery, own: readonly string[]): Promise<IndexAnswer> {
  const url = indexApiUrl(query, own);
  let pending = inflight.get(url);
  if (!pending) {
    pending = fetchIndexHits(query, own, AbortSignal.timeout(20000))
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

function vital(symbol: string, date: string | undefined, place: string | undefined): string | undefined {
  const parts = [date ? displayDateText(date) : "", place ?? ""].filter(Boolean);
  return parts.length ? `${symbol} ${parts.join(", ")}` : undefined;
}

function relativesLine(hit: IndexHit): string {
  const names = (list: IndexHit["parents_list"]) =>
    (list ?? []).map((r) => [r.name, r.surname].filter(Boolean).join(" ")).filter(Boolean);
  return [...names(hit.parents_list), ...names(hit.partners_list)].join(" · ");
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
    <a className={`${className ?? ""} person-search-contributor-link`} href={contributorUrl(contributor)} target="_blank" rel="noopener noreferrer" title={title}>
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

/**
 * The rows a comparison shows: what the index agrees with, contradicts or
 * adds. What only the person has (their own sources, events the index never
 * records) is left out — it says nothing about the hit. A group heading stays
 * only over rows that do.
 */
function comparedRows(rows: FieldRow[]): FieldRow[] {
  const out: FieldRow[] = [];
  let heading: FieldRow | undefined;
  for (const row of rows) {
    if (row.isGroupHeader) {
      heading = row;
      continue;
    }
    if (row.state === "main-only" || row.mainSources || row.incomingSources) continue;
    if (heading) {
      out.push(heading);
      heading = undefined;
    }
    out.push(row);
  }
  return out;
}

/** One hit set against the person, field by field, as Merge would compare them. */
function HitComparison({
  person,
  dataset,
  hitsDs,
  ranked,
  index,
  onIndex,
  onBack,
  onCite,
}: {
  person: Individual;
  dataset: Dataset;
  hitsDs: Dataset;
  ranked: RankedHit[];
  index: number;
  onIndex: (i: number) => void;
  onBack: () => void;
  onCite: (url: string) => void;
}) {
  const { t } = useTranslation();
  const { hit, id, score } = ranked[index];
  const normalized = useMemo(() => hitsForComparison(hitsDs, dataset), [hitsDs, dataset]);
  const rows = useMemo(() => {
    const indi = normalized.individuals.get(id);
    return indi ? comparedRows(individualFieldRows(t, person, indi, dataset, normalized)) : [];
  }, [normalized, id, person, dataset, t]);
  const url = indexPersonUrl(hit);

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
      <table className="person-search-table">
        <thead>
          <tr>
            <th />
            <th>{t("indexSearch.thisPerson")}</th>
            <th>{t("indexSearch.site.index")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) =>
            row.isGroupHeader ? (
              <tr key={row.key} className="person-search-group">
                <th colSpan={3}>{row.displayLabel ?? row.label}</th>
              </tr>
            ) : (
              <tr key={row.key} className={`field ${row.state}`}>
                <td className="f-label">{row.displayLabel ?? row.label}</td>
                <td className="f-val gm-data" title={row.mainTitle}>
                  <FieldValue text={row.main} links={row.mainLinks} linkIcons={row.mainLinkIcons} />
                </td>
                <td className="f-val gm-data" title={row.incomingTitle}>
                  <FieldValue
                    text={row.incoming}
                    links={row.incomingLinks}
                    otherLinks={row.mainLinks}
                    linkIcons={row.incomingLinkIcons}
                    otherLinkIcons={row.mainLinkIcons}
                  />
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      <div className="person-search-hit-foot">
        <a className="tools-issue-link" href={url} target="_blank" rel="noopener noreferrer">
          {t("indexSearch.open")}
        </a>
        <button type="button" className="tools-issue-link" onClick={() => onCite(url)}>
          {t("indexSearch.cite")}
        </button>
      </div>
    </div>
  );
}

/**
 * The Edit view's search rail, in the Relatives rail's place: prefilled
 * search pages of the index, FamilySearch, Geni and WikiTree for the person
 * open in Edit, and — behind the "Look up details online" switch — the
 * index's own hits, asked for as soon as the rail shows the person, ranked
 * by the match score against them. A hit opens into a field-by-field
 * comparison with the person, stepping from hit to hit, and its index page
 * can be cited as a source.
 *
 * Keyed by person, so moving to another person starts a fresh search.
 */
export function PersonSearch({
  person,
  dataset,
  onCite,
}: {
  person: Individual;
  dataset: Dataset;
  /** Open Add source for this person with the hit's index link in it. */
  onCite: (url: string) => void;
}) {
  const { t } = useTranslation();
  const { allowLinkFetch, indexContributor, indexExact } = useSettingsSlice(SETTINGS_KEYS);
  const setSettings = useSetSettings();
  const own = useMemo(() => contributorList(indexContributor), [indexContributor]);
  const ownKey = own.join(",");
  const query = useMemo(() => {
    const q = personQuery(person, dataset);
    return q && indexExact ? { ...q, exact: true } : q;
  }, [person, dataset, indexExact]);
  const living = useMemo(
    () => !!livingReason(person, dataset, defaultPrivacyOptions(), new Date().getFullYear()),
    [person, dataset],
  );
  const [search, setSearch] = useState<SearchState>(() => {
    const cached = query && answered.get(indexApiUrl(query, own));
    return cached ? { state: "done", ...settle(person, dataset, cached, own) } : { state: "idle" };
  });
  const [attempt, setAttempt] = useState(0);
  /** The hit open in the comparison, by its place in `flat`. */
  const [comparing, setComparing] = useState<number | null>(null);

  const searchable = !!query && allowLinkFetch && !living;
  // Ask the index as soon as it may be asked: on showing the person, on the
  // switch being turned on, on a changed own-tree name or exact choice, and
  // again on "Try again". An answer already held (the cache) leaves nothing to ask.
  useEffect(() => {
    if (!searchable || !query) return;
    const cached = answered.get(indexApiUrl(query, own));
    if (cached) {
      setSearch({ state: "done", ...settle(person, dataset, cached, own) });
      return;
    }
    let cancelled = false;
    setSearch({ state: "loading" });
    setComparing(null);
    askIndex(query, own)
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
    // `attempt` re-runs the search after an error.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchable, attempt, ownKey, indexExact]);

  const retry = () => {
    setSearch({ state: "idle" });
    setAttempt((n) => n + 1);
  };

  const flat = search.state === "done" ? search.flat : [];
  const open = search.state === "done" && searchable && comparing !== null && comparing < flat.length;

  return (
    <aside
      className={`edit-wider person-search${open ? " comparing" : ""}`}
      id="edit-search"
      aria-labelledby="edit-search-title"
    >
      <div className="edit-wider-head">
        <div className="edit-wider-title">
          <strong id="edit-search-title">{t("indexSearch.title")}</strong>
          {search.state === "done" && <span className="edit-wider-count gm-data">{search.total}</span>}
        </div>
        {query ? (
          <div className="person-search-sites">
            <span className="person-search-label">{t("indexSearch.searchOn")}</span>
            {SEARCH_SITES.map((site) => (
              <a key={site} className="person-search-site" href={searchUrl(site, query)} target="_blank" rel="noopener noreferrer">
                {t(`indexSearch.site.${site}`)} <ExternalIcon size={11} />
              </a>
            ))}
          </div>
        ) : (
          <p className="person-search-note">{t("indexSearch.noName")}</p>
        )}
      </div>
      {query && (
        <div className="edit-wider-body person-search-index">
          <div className="person-search-index-head">
            <h3 className="person-search-index-title">{t("indexSearch.site.index")}</h3>
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
            />
          ) : (
            <>
              <ol className="person-search-hits">
                {search.clusters.map((cluster) => {
                  const [{ hit, score }, ...others] = cluster.members;
                  const at = (r: RankedHit) => flat.indexOf(r);
                  const facts = [
                    vital("*", hit.date_of_birth || hit.date_of_baptism, hit.place_of_birth || hit.place_of_baptism),
                    vital("†", hit.date_of_death, hit.place_of_death),
                    vital("⚰", hit.date_of_burial, hit.place_of_burial),
                  ].filter((f): f is string => !!f);
                  const relatives = relativesLine(hit);
                  return (
                    <li key={hit.id} className="person-search-hit">
                      <div className="person-search-hit-name">
                        <span className="person-search-score" title={t("indexSearch.scoreTip")}>{Math.round(score)}</span>
                        <button type="button" className="person-search-hit-open" onClick={() => setComparing(at(cluster.members[0]))}>
                          {hitName(hit)}
                        </button>
                      </div>
                      {cluster.inOwnTree && <div className="person-search-own">{t("indexSearch.inOwnTree")}</div>}
                      {facts.map((f) => <div key={f} className="person-search-hit-fact">{f}</div>)}
                      {relatives && <div className="person-search-hit-relatives">{relatives}</div>}
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
        </div>
      )}
    </aside>
  );
}
