import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, Individual } from "../../gedcom/types";
import { displayDateText } from "../../gedcom/dateDisplay";
import { defaultPrivacyOptions, livingReason } from "../../tools/privacy";
import { personQuery, searchUrl, SEARCH_SITES, type PersonQuery } from "../../online/searchLinks";
import { fetchIndexHits, hitGedcom, hitXref, indexApiUrl, indexPersonUrl, rankHits, type IndexHit, type RankedHit } from "../../online/indexSearch";
import { useSettingsSlice } from "../SettingsContext";
import { ExternalIcon } from "../icons/ExternalIcon";

const SETTINGS_KEYS = ["allowLinkFetch"] as const;

/** How many ranked hits the panel lists. */
const SHOWN = 10;

/** Answers already fetched this session, by API address — returning to a
 *  person does not ask the index again. */
const answered = new Map<string, IndexHit[]>();
const ANSWERED_CAP = 100;

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
 * Search elsewhere for the person open in Edit: prefilled search pages of the
 * index, FamilySearch, Geni and WikiTree, and — behind the "Look up details
 * online" switch — the index's own hits, ranked by the match score against
 * this person, each one ready to compare in Merge.
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

  if (!query) return <div className="person-search"><p className="person-search-note">{t("indexSearch.noName")}</p></div>;

  const run = async (q: PersonQuery) => {
    setSearch({ state: "loading" });
    try {
      const hits = await fetchIndexHits(q, AbortSignal.timeout(20000));
      if (answered.size >= ANSWERED_CAP) answered.delete(answered.keys().next().value!);
      answered.set(indexApiUrl(q), hits);
      setSearch({ state: "done", ranked: rankHits(person, dataset, hits) });
    } catch {
      setSearch({ state: "error" });
    }
  };

  const compare = (hit: IndexHit) => {
    const surname = (hit.surname || "index").replace(/[^\p{L}\p{N}-]+/gu, "_");
    onCompare(person.id, hitXref(0), `indeks-${surname}-${hit.id}.ged`, hitGedcom(hit));
  };

  return (
    <div className="person-search">
      <div className="person-search-sites">
        <span className="person-search-label">{t("indexSearch.searchOn")}</span>
        {SEARCH_SITES.map((site) => (
          <a key={site} className="person-search-site" href={searchUrl(site, query)} target="_blank" rel="noopener noreferrer">
            {t(`indexSearch.site.${site}`)} <ExternalIcon size={12} />
          </a>
        ))}
      </div>
      <div className="person-search-index">
        {living ? (
          <p className="person-search-note">{t("indexSearch.living")}</p>
        ) : !allowLinkFetch ? (
          <p className="person-search-note">{t("indexSearch.fetchOff", { setting: t("settings.links.fetch") })}</p>
        ) : (
          <>
            {search.state !== "done" && (
              <button type="button" className="tools-issue-link" disabled={search.state === "loading"} onClick={() => void run(query)}>
                {t(search.state === "loading" ? "indexSearch.searching" : "indexSearch.search")}
              </button>
            )}
            {search.state === "error" && <span className="person-search-note">{t("indexSearch.error")}</span>}
            {search.state === "done" && !search.ranked.length && <p className="person-search-note">{t("indexSearch.none")}</p>}
            {search.state === "done" && search.ranked.length > 0 && (
              <ol className="person-search-hits">
                {search.ranked.slice(0, SHOWN).map(({ hit, score }) => {
                  const facts = [
                    vital("*", hit.date_of_birth || hit.date_of_baptism, hit.place_of_birth || hit.place_of_baptism),
                    vital("†", hit.date_of_death, hit.place_of_death),
                    vital("⚰", hit.date_of_burial, hit.place_of_burial),
                  ].filter(Boolean);
                  const relatives = relativesLine(hit);
                  return (
                    <li key={hit.id} className="person-search-hit">
                      <span className="person-search-score" title={t("indexSearch.scoreTip")}>{Math.round(score)}</span>
                      <div className="person-search-hit-body">
                        <div className="person-search-hit-name">
                          {[hit.name, hit.surname].filter(Boolean).join(" ")}
                          <span className="person-search-contributor">{hit.contributor}</span>
                        </div>
                        {facts.length > 0 && <div className="person-search-hit-facts">{facts.join("  ")}</div>}
                        {relatives && <div className="person-search-hit-relatives">{relatives}</div>}
                      </div>
                      <div className="person-search-hit-actions">
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
          </>
        )}
      </div>
    </div>
  );
}
