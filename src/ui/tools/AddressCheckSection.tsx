import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { searchLocalAddress } from "../../geo/addressLookup";
import type { AddressHit } from "../../geo/addressRegister";
import { isOfflineQuery } from "../../geo/rn";
import { foldSearch } from "../globalSearch";
import type { Dataset } from "../../gedcom/types";
import type { KinshipResolver } from "../../match/kinship";
import { deleteDecision, putDecisions, type GeocodeDecision } from "../../persist/geoDb";
import {
  addressDecisionKey,
  ADDRESS_ASIDE,
  ADDRESS_VERDICTS,
  checkAddressesAgainstRegister,
  type AddressCheckReport,
  type AddressFinding,
  type AddressVerdict,
} from "../../tools/addressCheck";
import type { AddressRename, AddressRow } from "../../tools/addresses";
import { countryOf } from "../../tools/geocode";
import { REGISTER_DISMISSED } from "../../tools/registerCheck";
import { useLocalRegisters } from "../useLocalRegisters";
import { AppliedNote, ExpandAllToggle, GeoPeopleList, GeoRowHeader, MapToggle, RowMap } from "./shared";
import { CountryChips } from "./CountryChips";

// The compliance tab's second half: the file's houses held against a downloaded
// address register.
//
// Run when the tab is opened, and not before. A register most files will not
// have is what this needs, so the section is not offered at all where none is
// stored; where one is, holding the whole file against it is IndexedDB reads and
// nothing more, and making that a button only meant the answer went unseen.
// The button remains for the progress it reports while a long file fills in.
//
// See addressCheck.ts for why a number the register does not have is counted
// rather than listed.

/** Which badge colour a verdict wears, in the vocabulary the places findings
 *  use: "new" for a value that would become a different place, "official" for
 *  the register's own wording, and the link colour for the aside that proposes
 *  nothing to take. */
const BADGE: Record<AddressVerdict, string> = {
  addrElsewhere: "new",
  addrSpelling: "official",
  addrMissing: "reuse",
};

/** What a row has to disclose behind its caret: the register's own full line for
 *  the house — the answer every finding here is drawn from — and the map of
 *  where it puts it. A number the register lacks has no line to show, and says
 *  all it has to say on the header. */
function hasDetail(f: AddressFinding): boolean {
  return !!f.official;
}

/** Addresses resolved per pass, so a long file fills in rather than freezing. */
const CHUNK = 200;

/** Rows drawn at once; the rest wait behind the page search, as every list on
 *  this page does. */
const MAX_ROWS = 300;

export function AddressCheckSection({
  hidden,
  actionsHost,
  onCount,
  rows,
  dataset,
  decisions,
  query,
  kinship,
  onNavigate,
  onRenameAddresses,
  onDecisionsChanged,
}: {
  /** Every place+address pair in the file — the Addresses tab's own rows. */
  rows: AddressRow[];
  decisions: ReadonlyMap<string, GeocodeDecision>;
  /** The page-wide search, already folded. */
  query: string;
  kinship?: KinshipResolver;
  onNavigate: (id: string) => void;
  /** Rewrite one house's address on every event carrying it. */
  onRenameAddresses: (renames: AddressRename[]) => number;
  onDecisionsChanged: () => void;
  dataset: Dataset;
  /** Kept mounted but off screen while the other compliance tab is shown — a
   *  report costs a pass over the file, and switching tabs must not throw it
   *  away. */
  hidden?: boolean;
  /** Tab-row element to render this list's own buttons into (portal) — where
   *  the other three geocoding lists keep theirs. Null until the slot mounts,
   *  and while the other compliance tab is the one on screen. */
  actionsHost?: HTMLElement | null;
  /** How many findings there are, for the tab that names this list. Null until
   *  the check has been run, so the tab promises no count for work not done. */
  onCount: (count: number | null) => void;
}) {
  const { t } = useTranslation();
  useLocalRegisters();
  const [report, setReport] = useState<AddressCheckReport | null>(null);
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);
  const [verdictFilter, setVerdictFilter] = useState<"all" | AddressVerdict>("all");
  /** The country on screen — `null` = all of them. */
  const [countryFilter, setCountryFilter] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  /** Rows whose detail is showing, and — separately — rows showing their people.
   *  Two questions, two toggles: the caret asks what the register says about
   *  this house, the person count asks whom it belongs to. Opening one used to
   *  open both, so every glance at a row's detail unrolled thirty person links
   *  nobody had asked for. The places list beside this one splits them the same
   *  way. */
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [peopleOpen, setPeopleOpen] = useState<Set<string>>(new Set());
  /** Which places are unfolded, folded away to begin with exactly as on the
   *  geocoding addresses list: a village of fifty findings is one line naming
   *  the place and counting them, and the list is read by places first. */
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  /** The one row showing its map — one at a time, as on the places list. */
  const [mapOpen, setMapOpen] = useState<string | null>(null);

  const toggleGroup = (place: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(place)) next.delete(place);
      else next.add(place);
      return next;
    });

  const toggleOpen = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const togglePeople = (key: string) =>
    setPeopleOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const [applied, setApplied] = useState<number | null>(null);

  /** The rows a stored register could answer — what the button offers, and all
   *  it will ask about. Everything else is another country's, or has no house
   *  number to look up. */
  const askable = useMemo(() => rows.filter((r) => r.queries.length > 0 && isOfflineQuery(r.queries)), [rows]);

  const run = async () => {
    setReport(null);
    setRunning({ done: 0, total: askable.length });
    const answers = new Map<string, AddressHit[]>();
    for (let at = 0; at < askable.length; at += CHUNK) {
      for (const row of askable.slice(at, at + CHUNK)) {
        const hits: AddressHit[] = [];
        for (const q of row.queries) {
          for (const h of await searchLocalAddress(q.country ?? "SI", q)) {
            if (!hits.some((o) => o.coord.lat === h.coord.lat && o.coord.lon === h.coord.lon)) hits.push(h);
          }
        }
        answers.set(row.key, hits);
      }
      setRunning({ done: Math.min(at + CHUNK, askable.length), total: askable.length });
    }
    setReport(checkAddressesAgainstRegister(rows, answers, decisions));
    setRunning(null);
  };

  /** Which set of rows the check has already been run for, so a tab switch does
   *  not run it twice. */
  const ranFor = useRef<AddressRow[] | null>(null);
  // Run as soon as the page is open — whichever tab is on screen — and again
  // after an edit re-scans the file. The button remains for the progress it
  // reports, but it should not have been the only way in: a stored register
  // answers a whole file in IndexedDB reads, which yield between houses, so
  // this costs the page nothing it can feel.
  //
  // It waited for its own tab to be shown, and that made the count on the tab
  // useless: the one thing it is there to say — whether the houses are worth a
  // look — could only be learnt by going and looking. Now the tab carries its
  // number by the time the reader's eye reaches it.
  useEffect(() => {
    if (!askable.length || ranFor.current === askable) return;
    ranFor.current = askable;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askable]);

  /** Hide a finding, or — on one already hidden — bring it back. The restore
   *  half was missing: the button read "Prikaži" and wrote the dismissal again,
   *  so a row put away by mistake could not be fetched out. The places list has
   *  always deleted the decision instead; this now does the same. */
  const dismiss = async (f: AddressFinding) => {
    const key = addressDecisionKey(f.key);
    if (f.dismissed) await deleteDecision(key);
    else await putDecisions([{ key, status: REGISTER_DISMISSED, ts: Date.now() }]);
    setReport((prev) =>
      prev
        ? { ...prev, findings: prev.findings.map((o) => (o.key === f.key ? { ...o, dismissed: !f.dismissed } : o)) }
        : prev,
    );
    onDecisionsChanged();
  };

  /** Take the register's spelling for these houses, all in one undoable step —
   *  the places list's "take the official names" for addresses. Rows answered
   *  this way leave the report rather than stay, claiming a disagreement the
   *  file no longer has. */
  const takeOfficial = (list: readonly AddressFinding[]) => {
    const renames = list
      .filter((f) => f.officialAddress)
      .map((f) => ({ rawKeys: f.rawKeys, from: f.written, to: f.officialAddress! }));
    if (!renames.length) return;
    setApplied(onRenameAddresses(renames));
    const done = new Set(list.map((f) => f.key));
    setReport((prev) => (prev ? { ...prev, findings: prev.findings.filter((o) => !done.has(o.key)) } : prev));
  };

  // What the tab above shows. Not derived there: the report is this section's
  // own state, since running the check is this section's own action.
  const findingCount = report ? report.findings.filter((f) => !f.dismissed).length : null;
  useEffect(() => {
    onCount(findingCount);
  }, [findingCount, onCount]);

  const view = useMemo(() => {
    if (!report) return null;
    // The aside verdict is off the default list on purpose — see addressCheck.
    // Its chip is the only way in, which is also what makes the count honest.
    const pool = report.findings.filter(
      (f) =>
        (showDismissed || !f.dismissed) &&
        (verdictFilter === ADDRESS_ASIDE ? f.verdict === ADDRESS_ASIDE : f.verdict !== ADDRESS_ASIDE),
    );
    const matched = query
      ? pool.filter((f) => foldSearch(f.place).includes(query) || foldSearch(f.written).includes(query))
      : pool;
    const inVerdict = (f: AddressFinding) =>
      verdictFilter === "all" || verdictFilter === ADDRESS_ASIDE || f.verdict === verdictFilter;

    // One chip per country the findings stand in — the same country key the
    // places compliance list and both geocoding lists chip on, so all four say
    // the same thing about the same file.
    const countries: string[] = [];
    for (const f of pool) {
      const c = countryOf(f.place);
      if (!countries.includes(c)) countries.push(c);
    }
    const activeCountry = countryFilter !== null && countries.includes(countryFilter) ? countryFilter : null;
    const inCountry = (f: AddressFinding) => activeCountry === null || countryOf(f.place) === activeCountry;
    const countryChips = countries.map((code) => ({
      code,
      count: matched.filter((f) => countryOf(f.place) === code && inVerdict(f)).length,
    }));
    const countryAll = matched.filter(inVerdict).length;

    // Every chip respects each filter but its own, so a picked country narrows
    // the verdict counts exactly as a picked verdict narrows the country counts.
    const counts = { addrElsewhere: 0, addrSpelling: 0, addrMissing: 0 };
    for (const f of report.findings) if ((showDismissed || !f.dismissed) && inCountry(f)) counts[f.verdict]++;
    const rows = matched.filter((f) => inVerdict(f) && inCountry(f));
    // Grouped under the place the houses belong to, the way the Addresses tab
    // groups its own rows: eleven findings in Ravna Gora are one village's
    // eleven houses, and repeating the place on every line said so eleven
    // times while hiding that they were one place at all.
    // The cap is applied here, where it is also announced below. It was
    // declared and reported but never applied: the note said 200 findings were
    // waiting behind the search while every one of them was on screen.
    const byPlace = new Map<string, AddressFinding[]>();
    for (const f of rows.slice(0, MAX_ROWS)) {
      const list = byPlace.get(f.place);
      if (list) list.push(f);
      else byPlace.set(f.place, [f]);
    }
    const groups = [...byPlace]
      .map(([place, findings]) => ({ place, findings }))
      .sort((a, b) => b.findings.length - a.findings.length || a.place.localeCompare(b.place));
    return {
      rows,
      groups,
      counts,
      all: counts.addrElsewhere + counts.addrSpelling,
      countryChips,
      countryAll,
      activeCountry,
      dismissedTotal: report.findings.filter((f) => f.dismissed).length,
    };
  }, [report, query, verdictFilter, countryFilter, showDismissed]);

  // Nothing stored for any country the file writes: the check cannot be made,
  // and a disabled button explaining why would only be a second copy of the
  // download it wants (Settings › Map). Say nothing at all.
  if (!askable.length) return null;

  /** The rows "expand all" opens under the places it opens. A grouped list has
   *  two levels, and opening only the outer one stopped exactly where the answer
   *  is: what the register itself says about the house, which lives behind the
   *  row's own caret. The flat places list next door opens its rows, so this
   *  opens both. */
  const detailRows = view ? view.groups.flatMap((g) => g.findings.filter(hasDetail).map((f) => f.key)) : [];
  const allOpen =
    !!view &&
    view.groups.length > 0 &&
    view.groups.every((g) => openGroups.has(g.place)) &&
    detailRows.every((key) => open.has(key));
  /** Every listed house whose spelling the register would rewrite — what the
   *  bulk button offers, counted over what is on screen so the number and the
   *  list agree. */
  const bulk = view ? view.rows.filter((f) => f.officialAddress && !f.dismissed) : [];

  // The run button and the bulk take belong beside the tabs, where the other
  // three geocoding lists keep theirs.
  const actions = (
    <>
      {!report ? (
        <button className="nav-btn tools-run" disabled={!!running} onClick={() => void run()}>
          {running
            ? t("tools.registerAddr.running", { done: running.done, total: running.total })
            : t("tools.registerAddr.check", { count: askable.length })}
        </button>
      ) : (
        bulk.length > 0 && (
          <button
            className="nav-btn primary tools-run"
            onClick={() => takeOfficial(bulk)}
            title={t("tools.registerAddr.takeAllHint")}
          >
            {t("tools.registerAddr.takeAll", { count: bulk.length })}
          </button>
        )
      )}
      <AppliedNote count={applied} />
    </>
  );

  return (
    <section className="tools-cleanup-section" style={hidden ? { display: "none" } : undefined}>
      {actionsHost ? createPortal(actions, actionsHost) : <p className="tools-fix-hint">{actions}</p>}
      <p className="tools-intro">{t("tools.registerAddr.intro")}</p>

      {report && (
        <>
          <p className="tools-fix-hint">
            {t("tools.registerAddr.summary", { checked: report.checked, ok: report.ok })}
            {report.skipped > 0 && (
              <>
                {" · "}
                <span title={t("tools.registerAddr.skippedHint")}>
                  {t("tools.registerAddr.skipped", { count: report.skipped })}
                </span>
              </>
            )}
          </p>
          {view && view.all === 0 && view.counts.addrMissing === 0 && (
            <p className="tools-clean tools-clean--ok">{t("tools.registerAddr.clean")}</p>
          )}
          {view && (view.all > 0 || view.counts.addrMissing > 0) && (
            <>
              <CountryChips
                chips={view.countryChips}
                all={view.countryAll}
                active={view.activeCountry}
                onPick={setCountryFilter}
              />
              <div className="tools-chips">
                <button
                  className={`tools-chip ${verdictFilter === "all" ? "active" : ""}`}
                  onClick={() => setVerdictFilter("all")}
                >
                  {t("tools.geocode.filter.all")} <span className="tools-chip-count">{view.all}</span>
                </button>
                {ADDRESS_VERDICTS.map((v) => (
                  <button
                    key={v}
                    className={`tools-chip ${verdictFilter === v ? "active" : ""}`}
                    onClick={() => setVerdictFilter(v)}
                    title={t(`tools.registerAddr.hint.${v}`)}
                  >
                    {t(`tools.registerAddr.verdict.${v}`)} <span className="tools-chip-count">{view.counts[v]}</span>
                  </button>
                ))}
                {/* A view control, beside the other view controls — the same
                    place the geocoding addresses list keeps its own. */}
                <ExpandAllToggle
                  allOpen={allOpen}
                  onToggle={() => {
                    if (allOpen) {
                      setOpenGroups(new Set());
                      setOpen(new Set());
                      setPeopleOpen(new Set());
                      setMapOpen(null);
                    } else {
                      setOpenGroups(new Set(view.groups.map((g) => g.place)));
                      setOpen(new Set(detailRows));
                    }
                  }}
                />
                {(view.dismissedTotal > 0 || showDismissed) && (
                  <label className="tools-reshape-site" title={t("tools.register.showDismissedHint")}>
                    <input
                      type="checkbox"
                      checked={showDismissed}
                      onChange={(e) => setShowDismissed(e.target.checked)}
                    />
                    {t("tools.register.showDismissed")}{" "}
                    <span className="tools-chip-count">{view.dismissedTotal}</span>
                  </label>
                )}
              </div>
              {!view.rows.length && <p className="tools-clean">{t("tools.search.noMatch")}</p>}
              <ul className="tools-geo-addr-list tools-register-list">
                {view.groups.map((group) => {
                  const groupOpen = openGroups.has(group.place);
                  return (
                  <li key={group.place} className="tools-geo-addr-group">
                    {/* The place the houses under it belong to, named once and
                        folding them away — the geocoding addresses list's own
                        group header, so a village of fifty findings is one line
                        until it is asked for. */}
                    <GeoRowHeader
                      open={groupOpen}
                      onToggle={() => toggleGroup(group.place)}
                      place={group.place || t("tools.geocode.addr.noPlace")}
                    >
                      {/* The geocoding list's own group line, string and all:
                          how many houses, and how many events hang on them. */}
                      <span className="tools-geo-count">
                        {t("tools.geocode.addr.groupMeta", {
                          count: group.findings.length,
                          events: group.findings.reduce((n, f) => n + f.count, 0),
                        })}
                      </span>
                    </GeoRowHeader>
                    {groupOpen && (
                    // The geocoding addresses list's own nesting: the houses sit
                    // indented under the place, behind the rule that says they
                    // belong to it. This list had them flush with the group
                    // heading, so a village and its houses read as one flat run.
                    <ul className="tools-tree-children tools-geo-addr-sublist">
                {group.findings.map((f) => {
                  const detail = hasDetail(f);
                  const showPeople = peopleOpen.has(f.key);
                  const isOpen = (detail && open.has(f.key)) || showPeople;
                  return (
                    <li key={f.key} className={`tools-geo-addr-row${f.dismissed ? " dismissed" : ""}`}>
                      {/* The shape the places findings use: the value the file
                          writes leads with the place it sits in beside it, the
                          register's answer follows, and the verdict, the
                          actions and the person count are pinned right, so the
                          eye runs down two clean columns. */}
                      <GeoRowHeader
                        open={isOpen}
                        caret={detail}
                        // The address lists' row line: it wraps, and it is the
                        // smaller type a house sits in, so both read alike.
                        className="tools-geo-addr-head"
                        onToggle={() => toggleOpen(f.key)}
                        // Not the header's `address` slot, and not
                        // .tools-geo-row-addr: that class draws the pin that
                        // marks a *position* everywhere in the app, and this
                        // row holds none — it is two ways of writing one house,
                        // and the pin said otherwise twice per line.
                        place={f.written}
                      >
                        {/* After the arrow stands what the file would say once
                            the row is taken — the exact replacement, note and
                            all, not the register's line it is derived from.
                            That line is a postal address with a post code the
                            file never wanted, and reading it here left the one
                            question that matters ("what will my record say?")
                            answered only by trying it. It is still shown, below,
                            as the answer this is drawn from.

                            A settlement finding changes no address text at all —
                            it moves the events — so it stands there written out
                            as it would be afterwards: the address unchanged, the
                            new place beside it. The place alone read as a
                            replacement of the address, and the register's postal
                            line before that read as one that dropped the
                            researcher's own note. A row with nothing to write at
                            all shows the register's line itself: there the
                            register's own words are the whole finding. */}
                        {(() => {
                          const moves = f.verdict === "addrElsewhere";
                          const becomes = moves
                            ? f.written
                            : (f.officialAddress ?? f.official);
                          const into = moves ? (f.officialPlace ?? f.settlement) : undefined;
                          return (
                            becomes && (
                              <>
                                <span aria-hidden="true" className="tools-register-place">→</span>
                                <span className="tools-geo-cand-name">{becomes}</span>
                                {into && <span className="tools-register-place">{into}</span>}
                              </>
                            )
                          );
                        })()}
                        <span className="tools-register-end">
                          <span
                            className={`tools-reshape-badge ${BADGE[f.verdict]}`}
                            title={t(`tools.registerAddr.hint.${f.verdict}`)}
                          >
                            {t(`tools.registerAddr.verdict.${f.verdict}`)}
                          </span>
                          {f.officialAddress && !f.dismissed && (
                            <button
                              className="tools-issue-link"
                              onClick={() => takeOfficial([f])}
                              title={t("tools.registerAddr.takeHint", { address: f.officialAddress })}
                            >
                              {t("tools.geocode.official.take")}
                            </button>
                          )}
                          <button
                            className="tools-issue-link"
                            onClick={() => void dismiss(f)}
                            title={t("tools.register.dismissHint")}
                          >
                            {f.dismissed ? t("tools.geocode.restore") : t("tools.geocode.hide")}
                          </button>
                          <button
                            className="tools-chip-count tools-count-toggle"
                            aria-pressed={showPeople}
                            aria-label={t("tools.geocode.peopleToggle")}
                            onClick={() => togglePeople(f.key)}
                          >
                            {f.people.length}
                          </button>
                        </span>
                      </GeoRowHeader>
                      {isOpen && (
                        <div className="tools-geo-conflict-body">
                          {/* Where the register puts the house — the question
                              behind every finding here, and the one a name
                              alone cannot settle. Asked for by a click, like
                              every other map on this page, and never drawn
                              before that: Leaflet is a lazy chunk. */}
                          {open.has(f.key) && f.coord && (
                            <div className="tools-geo-actions">
                              <MapToggle
                                open={mapOpen === f.key}
                                onToggle={() => setMapOpen(mapOpen === f.key ? null : f.key)}
                              />
                            </div>
                          )}
                          {mapOpen === f.key && f.coord && (
                            <RowMap
                              fitKey={f.key}
                              fitMaxZoom={17}
                              pins={[
                                {
                                  coord: f.coord,
                                  label: f.official ?? f.written,
                                  ...(f.settlement ? { sub: f.settlement } : {}),
                                  kind: "candidate",
                                },
                              ]}
                            />
                          )}
                          {/* The register's own answer, in the shape every other
                              geocoding list shows an answer in — one numbered
                              line, tied to the pin the map above draws for it.
                              Every finding drawn from a register line shows it
                              here, in the same shape: a settlement finding used
                              to state its place in prose instead, so the one
                              thing the two verdicts share looked like two
                              different things.

                              Where there is a spelling to take, the line is that
                              option: taking it writes the address in the header,
                              which is this line minus the post code and plus
                              whatever note the file's own value ends with. A
                              settlement finding offers nothing to click — the
                              move belongs on the Addresses tab, which has the
                              map to check the house on first. */}
                          {open.has(f.key) && f.official && (
                            <ul className="tools-geo-candidates">
                              <li>
                                {f.officialAddress ? (
                                  <label>
                                    <input
                                      type="radio"
                                      className="tools-geo-cand-radio"
                                      name={`registerAddr-${f.key}`}
                                      aria-label={f.official}
                                      disabled={f.dismissed}
                                      checked={false}
                                      onChange={() => takeOfficial([f])}
                                    />
                                    {/* The number IS the control everywhere on
                                        these pages — the input itself is clipped
                                        to a pixel, so an option without it drew
                                        no control at all. */}
                                    <span className="tools-geo-cand-num">1</span>
                                    <span className="tools-geo-cand-name">{f.official}</span>
                                  </label>
                                ) : (
                                  <span className="tools-geo-cand-line" title={t("tools.registerAddr.moveHint")}>
                                    <span className="tools-geo-cand-num">1</span>
                                    <span className="tools-geo-cand-name">{f.official}</span>
                                  </span>
                                )}
                              </li>
                            </ul>
                          )}
                          {showPeople && (
                            <GeoPeopleList
                              dataset={dataset}
                              ids={f.people}
                              place={f.place}
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
        </>
      )}
    </section>
  );
}

