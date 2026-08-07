import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { deleteDecision, putDecisions } from "../../persist/geoDb";
import { countryOf, pickLabel, type OfficialRename } from "../../tools/geocode";
import {
  directoryOf,
  registerDecisionKey,
  REGISTER_DISMISSED,
  REGISTER_VERDICTS,
  type RegisterCheckReport,
  type RegisterFinding,
  type RegisterVerdict,
} from "../../tools/registerCheck";
import { foldSearch } from "../globalSearch";
import { countryNameOf, proposalFromGazEntry, type PlaceStyle } from "../../geo/placeProposal";
import { ExpandAllToggle, GeoPeopleList, GeoRowHeader } from "./shared";
import type { Dataset } from "../../gedcom/types";
import type { KinshipResolver } from "../../match/kinship";
import type { GazEntry } from "../../geo/gazetteer";

// The Register tab: every place the file writes in a country an official
// register covers, held against that register, with the disagreements listed.
//
// A report, not a worklist of errors. The register describes the country as it
// is now and the file describes it as it was, so a name it no longer knows is
// often the right one — every row can be dismissed, and nothing is written
// without a click. The one write on offer is the rename the file's own
// "Use official name" already performs in the Places tab, applied here to
// places that are long since geocoded and would never appear there.

/** How many rows are painted before the list defers to the filters — the same
 *  cap the coordinate conflicts above use. */
const MAX_ROWS = 300;

/** Badge colour per verdict: the register knowing nothing of a place is the
 *  loud one, a different spelling the mildest. */
const BADGE: Record<RegisterVerdict, string> = {
  notFound: "remove",
  ambiguous: "reuse",
  admin: "remove",
  spelling: "official",
  address: "new",
  far: "reuse",
};

export function RegisterCheckSection({
  report,
  dataset,
  style,
  kinship,
  onNavigate,
  query,
  actionsHost,
  onApplyOfficialNames,
  onDecisionsChanged,
}: {
  /** The check's result, or null while no official register is loaded. */
  report: RegisterCheckReport | null;
  dataset: Dataset;
  /** How this file writes places — the layout every register answer here is
   *  shown in, so the reader compares like with like. */
  style: PlaceStyle;
  /** Kinship labels for a row's people list — the places rows' resolver. */
  kinship?: KinshipResolver;
  /** Jump to a person in Edit mode (the people list). */
  onNavigate: (id: string) => void;
  /** The page-wide search, already folded. */
  query: string;
  /** Tab-row element the action buttons render into (portal). */
  actionsHost?: HTMLElement | null;
  /** Rename places to their register spelling — one undoable step, the same
   *  handler the Places tab's "Take official names" uses (it fills a missing
   *  coordinate along the way and never overwrites one). */
  onApplyOfficialNames: (renames: OfficialRename[]) => number;
  /** Re-read the decision cache after a dismissal is written. */
  onDecisionsChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [verdictFilter, setVerdictFilter] = useState<"all" | RegisterVerdict>("all");
  /** ISO code of the country on screen, or null for all of them. */
  const [countryFilter, setCountryFilter] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const [applied, setApplied] = useState<number | null>(null);
  /** Rows opened for the register's answers, and — a second step, asked for by
   *  clicking the row's count — those showing the people too. The places list
   *  splits the two the same way. */
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [peopleOpen, setPeopleOpen] = useState<Set<string>>(new Set());
  /** Which answer the researcher picked, per row — the one a rename writes.
   *  Rows with a single answer need no pick; a name fitting several places has
   *  no default, since choosing between them is the whole question. */
  const [picked, setPicked] = useState<Map<string, number>>(new Map());

  const toggleOpen = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const togglePeople = (key: string) => {
    setPeopleOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
    setOpen((prev) => new Set(prev).add(key));
  };
  const pick = (key: string, index: number) => setPicked((prev) => new Map(prev).set(key, index));

  // A rename, an undo or an edit elsewhere re-runs the check, and the rows it
  // settles leave the list. Their open state and picks go with them — the same
  // sweep the other lists on this page make after a rescan.
  useEffect(() => {
    if (!report) return;
    const keys = new Set(report.findings.map((f) => f.key));
    setOpen((prev) => new Set([...prev].filter((k) => keys.has(k))));
    setPeopleOpen((prev) => new Set([...prev].filter((k) => keys.has(k))));
    setPicked((prev) => new Map([...prev].filter(([k]) => keys.has(k))));
  }, [report]);

  // Two chip rows, faceted the way the places list's are: a chip's count
  // respects every filter except its own row's, so the number on it is exactly
  // how many rows clicking it puts on screen.
  const view = useMemo(() => {
    if (!report) return null;
    const pool = report.findings.filter((f) => showDismissed || !f.dismissed);
    const searched = query ? pool.filter((f) => foldSearch(f.key).includes(query)) : pool;

    // One chip per country the findings are in — a file researched in one
    // country has nothing to narrow, so the row only appears from two up.
    const countries: string[] = [];
    for (const f of pool) if (!countries.includes(f.country)) countries.push(f.country);
    const activeCountry = countryFilter !== null && countries.includes(countryFilter) ? countryFilter : null;
    const inCountry = (f: RegisterFinding) => activeCountry === null || f.country === activeCountry;
    const inVerdict = (f: RegisterFinding) => verdictFilter === "all" || f.verdict === verdictFilter;

    // A chip is named the way the *file* names that country — "Slovenia" where
    // the file writes Slovenia, even when the reader's language would say
    // Slovenija — so the buttons here read like the ones over the places list,
    // which are the file's own last comma parts. Places whose country the file
    // spells two ways still share one chip (they are one country), under
    // whichever spelling it uses most.
    const spellings = new Map<string, Map<string, number>>();
    for (const f of pool) {
      const written = countryOf(f.key);
      if (!written) continue;
      const tally = spellings.get(f.country) ?? new Map<string, number>();
      tally.set(written, (tally.get(written) ?? 0) + 1);
      spellings.set(f.country, tally);
    }
    const countryChips = countries.map((code) => {
      const written = [...(spellings.get(code) ?? new Map())].sort((a, b) => b[1] - a[1])[0]?.[0];
      return {
        code,
        name: written ?? countryNameOf(code, i18n.language) ?? code,
        unknown: !written && !code,
        count: searched.filter((f) => f.country === code && inVerdict(f)).length,
      };
    });
    countryChips.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const countryAll = searched.filter(inVerdict).length;

    const counts: Record<RegisterVerdict, number> = { notFound: 0, ambiguous: 0, admin: 0, spelling: 0, address: 0, far: 0 };
    for (const f of searched) if (inCountry(f)) counts[f.verdict]++;

    const rows = searched.filter((f) => inVerdict(f) && inCountry(f));
    const dismissedTotal = report.findings.filter((f) => f.dismissed).length;
    return {
      rows,
      counts,
      all: searched.filter(inCountry).length,
      countryChips,
      countryAll,
      activeCountry,
      dismissedTotal,
    };
  }, [report, query, verdictFilter, countryFilter, showDismissed, i18n.language]);

  if (!report || !view) return null;

  /** The rename the row's picked answer amounts to: rename every occurrence to
   *  that place, and take the register's coordinate where the file has none.
   *  Nothing to rename on a dismissed row, on one with no answer picked, or
   *  where the answer is the value the file already writes. */
  const renameFor = (
    f: RegisterFinding,
    options: RegisterOption[],
    chosen: number,
  ): OfficialRename | undefined => {
    const o = chosen >= 0 ? options[chosen] : undefined;
    if (!o || f.dismissed || (o.place === f.key && !o.addr)) return undefined;
    return {
      from: f.key,
      to: o.place,
      ...(o.addr ? { addr: o.addr } : {}),
      ...(o.entry ? { assignment: { coord: { lat: o.entry.lat, lon: o.entry.lon } } } : {}),
    };
  };

  /** What "Use official names" would write: every shown row that has an answer
   *  to take. A row whose several places nobody has chosen between is not one
   *  of them — that is the researcher's call, one row at a time. */
  const bulk = view.rows.flatMap((f) => {
    const options = optionsOf(f, style);
    return renameFor(f, options, chosenIndex(f, options, picked)) ?? [];
  });
  const allOpen = view.rows.length > 0 && view.rows.every((f) => open.has(f.key));

  const dismiss = async (f: RegisterFinding) => {
    const key = registerDecisionKey(f.key);
    if (f.dismissed) await deleteDecision(key);
    else await putDecisions([{ key, status: REGISTER_DISMISSED, ts: Date.now() }]);
    onDecisionsChanged();
  };

  const actions = (
    <>
      {bulk.length > 0 && (
        <button
          className="nav-btn primary tools-run"
          onClick={() => setApplied(onApplyOfficialNames(bulk))}
          title={t("tools.register.takeAllHint")}
        >
          {t("tools.register.takeAll", { count: bulk.length })}
        </button>
      )}
      <ExpandAllToggle
        allOpen={allOpen}
        onToggle={() => {
          if (allOpen) {
            setOpen(new Set());
            setPeopleOpen(new Set());
          } else setOpen(new Set(view.rows.map((f) => f.key)));
        }}
      />
    </>
  );

  const summary = report.registers.length
    ? t("tools.register.summary", {
        checked: report.checked,
        ok: report.ok,
        registers: report.registers.join(", "),
      })
    : t("tools.register.noRegister");

  return (
    <section className="tools-cleanup-section">
      {actionsHost ? (
        createPortal(actions, actionsHost)
      ) : (
        <div className="tools-dup-kind-head">
          {t("tools.register.heading")}
          <span className="tools-chip-count">{report.findings.length}</span>
          <div className="tools-dup-bulk">{actions}</div>
        </div>
      )}
      <p className="tools-intro">{t("tools.register.intro")}</p>
      <p className="tools-fix-hint">{summary}</p>
      {report.skipped > 0 && <p className="tools-fix-hint">{t("tools.register.skipped", { count: report.skipped })}</p>}
      {applied !== null && <p className="tools-clean tools-clean--ok">{t("tools.geocode.applied", { count: applied })}</p>}

      {report.registers.length > 0 && report.findings.length === 0 && (
        <p className="tools-clean tools-clean--ok">{t("tools.register.clean")}</p>
      )}

      {report.findings.length > 0 && (
        <>
          {view.countryChips.length > 1 && (
            <div className="tools-chips">
              <button
                className={`tools-chip ${view.activeCountry === null ? "active" : ""}`}
                onClick={() => setCountryFilter(null)}
              >
                {t("tools.geocode.filter.all")} <span className="tools-chip-count">{view.countryAll}</span>
              </button>
              {view.countryChips.map((c) => (
                <button
                  key={c.code}
                  className={`tools-chip ${view.activeCountry === c.code ? "active" : ""}`}
                  onClick={() => setCountryFilter(c.code)}
                >
                  {c.unknown ? t("tools.geocode.countryUnknown") : c.name}{" "}
                  <span className="tools-chip-count">{c.count}</span>
                </button>
              ))}
            </div>
          )}
          <div className="tools-chips">
            <button
              className={`tools-chip ${verdictFilter === "all" ? "active" : ""}`}
              onClick={() => setVerdictFilter("all")}
            >
              {t("tools.geocode.filter.all")} <span className="tools-chip-count">{view.all}</span>
            </button>
            {REGISTER_VERDICTS.map((v) => (
              <button
                key={v}
                className={`tools-chip ${verdictFilter === v ? "active" : ""}`}
                onClick={() => setVerdictFilter(v)}
                title={t(`tools.register.hint.${v}`)}
              >
                {t(`tools.register.verdict.${v}`)} <span className="tools-chip-count">{view.counts[v]}</span>
              </button>
            ))}
            {(view.dismissedTotal > 0 || showDismissed) && (
              <label className="tools-reshape-site" title={t("tools.register.showDismissedHint")}>
                <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} />
                {t("tools.register.showDismissed")} <span className="tools-chip-count">{view.dismissedTotal}</span>
              </label>
            )}
          </div>

          {!view.rows.length && <p className="tools-clean">{t("tools.search.noMatch")}</p>}
          <ul className="tools-tree tools-register-list">
            {view.rows.slice(0, MAX_ROWS).map((f) => {
              const options = optionsOf(f, style);
              const chosen = chosenIndex(f, options, picked);
              const rename = renameFor(f, options, chosen);
              const isOpen = open.has(f.key) || peopleOpen.has(f.key);
              return (
                <li key={f.key} className={`tools-tree-node${f.dismissed ? " dismissed" : ""}`}>
                  {/* The same row shape as the places and addresses lists: the
                      value the file writes leads, what the register answers
                      follows it, and the badge, the actions and the person
                      count sit at the end. */}
                  <GeoRowHeader open={isOpen} onToggle={() => toggleOpen(f.key)} place={f.key}>
                    {chosen >= 0 ? (
                      <>
                        {options[chosen].entry && (
                          <span
                            className={`tools-reshape-badge ${options[chosen].entry.register ? "official" : "reuse"}`}
                            title={t("tools.register.registerBadgeHint")}
                          >
                            {directoryOf(options[chosen].entry)}
                          </span>
                        )}
                        <span className="tools-geo-cand-name">{options[chosen].place}</span>
                        {options[chosen].addr && (
                          <span className="tools-geo-row-addr">· {options[chosen].addr}</span>
                        )}
                      </>
                    ) : (
                      // Several places of this name, none of them picked yet:
                      // the header says how many there are rather than naming
                      // one of them, which would read as the answer.
                      options.length > 1 && (
                        <span className="tools-geo-count">{t("tools.register.options", { count: options.length })}</span>
                      )
                    )}
                    {f.verdict === "far" && (
                      <span className="tools-geo-count">{t("tools.register.detail.far", { km: Math.round(f.distanceKm ?? 0) })}</span>
                    )}
                    {/* The verdict, what can be done about it and who it
                        concerns, pinned to the right of the row so the eye can
                        run down the places and the badges in two clean columns. */}
                    <span className="tools-register-end">
                      <span className={`tools-reshape-badge ${BADGE[f.verdict]}`} title={t(`tools.register.hint.${f.verdict}`)}>
                        {t(`tools.register.verdict.${f.verdict}`)}
                      </span>
                      {rename && (
                        <button
                          className="tools-issue-link"
                          onClick={() => setApplied(onApplyOfficialNames([rename]))}
                          title={t("tools.register.takeHint", { place: rename.to })}
                        >
                          {t("tools.geocode.official.take")}
                        </button>
                      )}
                      <button
                        className="tools-issue-link"
                        onClick={() => void dismiss(f)}
                        title={f.dismissed ? t("tools.register.undismissHint") : t("tools.register.dismissHint")}
                      >
                        {f.dismissed ? t("tools.register.undismiss") : t("tools.register.dismiss")}
                      </button>
                      <button
                        className="tools-chip-count tools-count-toggle"
                        aria-pressed={peopleOpen.has(f.key)}
                        aria-label={t("tools.geocode.peopleToggle")}
                        onClick={() => togglePeople(f.key)}
                      >
                        {f.people.length}
                      </button>
                    </span>
                  </GeoRowHeader>
                  {isOpen && (
                    <div className="tools-geo-conflict-body">
                      {/* The register's answers, one numbered option per line —
                          the same list, and the same numbered radios, the
                          places and addresses rows offer their candidates in.
                          Picking one is what the rename then writes. */}
                      {options.length > 0 && (
                        <ul className="tools-geo-candidates">
                          {options.map((o, i) => (
                            <li key={i}>
                              <label>
                                <input
                                  type="radio"
                                  className="tools-geo-cand-radio"
                                  name={`register-${f.key}`}
                                  aria-label={o.place}
                                  checked={chosen === i}
                                  onChange={() => pick(f.key, i)}
                                />
                                <span className="tools-geo-cand-num">{i + 1}</span>
                                <span className="tools-geo-cand-name">{o.place}</span>
                                {/* The house the split moves onto the event's
                                    own ADDR line, shown where it will land. */}
                                {o.addr && <span className="tools-geo-row-addr">ADDR: {o.addr}</span>}
                                {o.entry && (
                                  <>
                                    <span className="gm-data gm-coord">
                                      {o.entry.lat.toFixed(4)}, {o.entry.lon.toFixed(4)}
                                    </span>
                                    <span className={`tools-reshape-badge ${o.entry.register ? "official" : "reuse"}`}>
                                      {directoryOf(o.entry)}
                                    </span>
                                  </>
                                )}
                              </label>
                            </li>
                          ))}
                        </ul>
                      )}
                      {!options.length && <p className="tools-clean">{t(`tools.register.hint.${f.verdict}`)}</p>}
                      {peopleOpen.has(f.key) && (
                        <GeoPeopleList
                          dataset={dataset}
                          ids={f.people}
                          place={f.key}
                          kinship={kinship}
                          onNavigate={onNavigate}
                        />
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {view.rows.length > MAX_ROWS && (
            <p className="tools-fix-hint">{t("tools.geocode.more", { count: view.rows.length - MAX_ROWS })}</p>
          )}
        </>
      )}
    </section>
  );
}

/** One answer a row offers: the place it would be written as, the address to
 *  move out of it (the place/address split), and the register entry behind it
 *  where a register is what proposed it. */
interface RegisterOption {
  place: string;
  addr?: string;
  entry?: GazEntry;
}

/**
 * The register's answers to a row, as places rather than as entries.
 *
 * A row the register disagrees with in one level (its spelling of the
 * settlement, the municipality it files it under) has one answer: the value the
 * file writes with that level swapped, which keeps every other level, the
 * file's separator and any annotation it carries. A name fitting several
 * register entries has one answer per entry, each composed from locality,
 * municipality and country in the file's own layout, depth and country spelling
 * — the same shaping a register offer gets in an Edit field — so the choice is
 * made between whole places, not between "name (municipality)" labels.
 *
 * The verdicts a rename does not answer — a place the register does not hold, a
 * coordinate that is off — offer none.
 */
function optionsOf(f: RegisterFinding, style: PlaceStyle): RegisterOption[] {
  if (f.verdict === "ambiguous") {
    return (f.alternatives ?? []).map((entry) => ({ entry, place: placeTextOf(entry, style) }));
  }
  if ((f.verdict === "spelling" || f.verdict === "admin") && f.entry) {
    return [{ entry: f.entry, place: f.official ?? placeTextOf(f.entry, style) }];
  }
  // The place/address split: the settlement left in PLAC, the house on its own
  // ADDR line, both already shaped by the file's own layout.
  if (f.verdict === "address" && f.official && f.officialAddr) {
    return [{ place: f.official, addr: f.officialAddr }];
  }
  return [];
}

/** The answer the row stands on: the researcher's pick, else the only answer
 *  there is. -1 when several places are on offer and none has been chosen. */
function chosenIndex(f: RegisterFinding, options: RegisterOption[], picked: ReadonlyMap<string, number>): number {
  const own = picked.get(f.key);
  if (own !== undefined && own < options.length) return own;
  return options.length === 1 ? 0 : -1;
}

function placeTextOf(entry: GazEntry, style: PlaceStyle): string {
  return proposalFromGazEntry(entry, style)?.plac ?? pickLabel(entry.name, entry.admin);
}
