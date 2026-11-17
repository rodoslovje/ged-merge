import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, Individual } from "../../gedcom/types";
import { displayDateText } from "../../gedcom/dateDisplay";
import { defaultPrivacyOptions, livingReason } from "../../tools/privacy";
import { personQuery, searchUrl, SEARCH_SITES, type PersonQuery } from "../../online/searchLinks";
import { fetchIndexHits, hitGedcom, hitXref, indexApiUrl, indexPersonUrl, rankHits, type IndexHit, type RankedHit } from "../../online/indexSearch";
import { useSettingsSlice } from "../SettingsContext";
import { ExternalIcon } from "../icons/ExternalIcon";

const SETTINGS_KEYS = ["allowLinkFetch"] as const;

/** How many ranked hits the rail lists. */
const SHOWN = 10;

/** Answers already fetched this session, by API address — returning to a
 *  person does not ask the index again. */
const answered = new Map<string, IndexHit[]>();
const ANSWERED_CAP = 100;
/** Searches on their way, by API address — a rail shown again before the
 *  answer arrives waits for the same request instead of sending another. */
const inflight = new Map<string, Promise<IndexHit[]>>();

function askIndex(query: PersonQuery): Promise<IndexHit[]> {
  const url = indexApiUrl(query);
  let pending = inflight.get(url);
  if (!pending) {
    pending = fetchIndexHits(query, AbortSignal.timeout(20000))
      .then((hits) => {
        if (answered.size >= ANSWERED_CAP) answered.delete(answered.keys().next().value!);
        answered.set(url, hits);
        return hits;
      })
      .finally(() => inflight.delete(url));
    inflight.set(url, pending);
  }
  return pending;
}

type SearchState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error" }
  | { state: "done"; ranked: RankedHit[] };

function vital(symbol: string, date: string | undefined, place: string | undefined): string | undefined {
  const parts = [date ? displayDateText(date) : "", place ?? ""].filter(Boolean);
  return parts.length ? `${symbol} ${parts.join(", ")}` : undefined;
}

function relativesLine(hit: IndexHit): string {
  const names = (list: IndexHit["parents_list"]) =>
    (list ?? []).map((r) => [r.name, r.surname].filter(Boolean).join(" ")).filter(Boolean);
  return [...names(hit.parents_list), ...names(hit.partners_list)].join(" · ");
}

/**
 * The Edit view's search rail, in the Relatives rail's place: prefilled
 * search pages of the index, FamilySearch, Geni and WikiTree for the person
 * open in Edit, and — behind the "Look up details online" switch — the
 * index's own hits, asked for as soon as the rail shows the person, ranked
 * by the match score against them, each ready to compare in Merge.
 *
 * Keyed by person, so moving to another person starts a fresh search.
 */
export function PersonSearch({
  person,
  dataset,
  onCompare,
}: {
  person: Individual;
  dataset: Dataset;
  /** Load one hit as the incoming file and open its pair with this person. */
  onCompare: (mainId: string, compareId: string, fileName: string, text: string) => void;
}) {
  const { t } = useTranslation();
  const { allowLinkFetch } = useSettingsSlice(SETTINGS_KEYS);
  const query = useMemo(() => personQuery(person, dataset), [person, dataset]);
  const living = useMemo(
    () => !!livingReason(person, dataset, defaultPrivacyOptions(), new Date().getFullYear()),
    [person, dataset],
  );
  const [search, setSearch] = useState<SearchState>(() => {
    const cached = query && answered.get(indexApiUrl(query));
    return cached ? { state: "done", ranked: rankHits(person, dataset, cached) } : { state: "idle" };
  });
  const [attempt, setAttempt] = useState(0);

  const searchable = !!query && allowLinkFetch && !living;
  // Ask the index as soon as it may be asked: on showing the person, on the
  // switch being turned on, and again on "Try again". An answer already held
  // (the cache) leaves nothing to ask.
  useEffect(() => {
    if (!searchable || !query || search.state !== "idle") return;
    let cancelled = false;
    setSearch({ state: "loading" });
    askIndex(query)
      .then((hits) => {
        if (!cancelled) setSearch({ state: "done", ranked: rankHits(person, dataset, hits) });
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
  }, [searchable, attempt]);

  const compare = (hit: IndexHit) => {
    const surname = (hit.surname || "index").replace(/[^\p{L}\p{N}-]+/gu, "_");
    onCompare(person.id, hitXref(0), `indeks-${surname}-${hit.id}.ged`, hitGedcom(hit));
  };

  const retry = () => {
    setSearch({ state: "idle" });
    setAttempt((n) => n + 1);
  };

  return (
    <aside className="edit-wider person-search" id="edit-search" aria-labelledby="edit-search-title">
      <div className="edit-wider-head">
        <div className="edit-wider-title">
          <strong id="edit-search-title">{t("indexSearch.title")}</strong>
          {search.state === "done" && <span className="edit-wider-count gm-data">{search.ranked.length}</span>}
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
          <h3 className="person-search-index-title">{t("indexSearch.site.index")}</h3>
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
          ) : !search.ranked.length ? (
            <p className="person-search-note">{t("indexSearch.none")}</p>
          ) : (
            <ol className="person-search-hits">
              {search.ranked.slice(0, SHOWN).map(({ hit, score }) => {
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
                      <span>{[hit.name, hit.surname].filter(Boolean).join(" ")}</span>
                    </div>
                    {facts.map((f) => <div key={f} className="person-search-hit-fact">{f}</div>)}
                    {relatives && <div className="person-search-hit-relatives">{relatives}</div>}
                    <div className="person-search-hit-foot">
                      <span className="person-search-contributor">{hit.contributor}</span>
                      <a className="tools-issue-link" href={indexPersonUrl(hit)} target="_blank" rel="noopener noreferrer">
                        {t("indexSearch.open")}
                      </a>
                      <button type="button" className="tools-issue-link" onClick={() => compare(hit)}>
                        {t("indexSearch.compare")}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </aside>
  );
}
