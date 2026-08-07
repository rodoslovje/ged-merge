import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { searchLocalAddress } from "../../geo/addressLookup";
import type { AddressHit } from "../../geo/addressRegister";
import { isOfflineQuery } from "../../geo/rn";
import { foldSearch } from "../globalSearch";
import type { Dataset } from "../../gedcom/types";
import type { KinshipResolver } from "../../match/kinship";
import { putDecisions, type GeocodeDecision } from "../../persist/geoDb";
import {
  addressDecisionKey,
  ADDRESS_ASIDE,
  ADDRESS_VERDICTS,
  checkAddressesAgainstRegister,
  type AddressCheckReport,
  type AddressFinding,
  type AddressVerdict,
} from "../../tools/addressCheck";
import type { AddressRow } from "../../tools/addresses";
import { countryOf } from "../../tools/geocode";
import { REGISTER_DISMISSED } from "../../tools/registerCheck";
import { useLocalRegisters } from "../useLocalRegisters";
import { AppliedNote, ExpandAllToggle, GeoPeopleList, GeoRowHeader } from "./shared";

// The compliance tab's second half: the file's houses held against a downloaded
// address register.
//
// Asked for, never automatic. The places above are checked the moment the tab
// opens because a gazetteer is already in memory; the houses need a register
// that most files will not have, and holding a whole file's addresses against
// one is a decision with a visible answer — thousands of rows, most of them
// about numbering that changed a century ago. So the section is a button until
// it is pressed, and it is not offered at all where no register is stored.
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

/** Addresses resolved per pass, so a long file fills in rather than freezing. */
const CHUNK = 200;

/** Rows drawn at once; the rest wait behind the page search, as every list on
 *  this page does. */
const MAX_ROWS = 300;

export function AddressCheckSection({
  hidden,
  onCount,
  rows,
  dataset,
  decisions,
  query,
  kinship,
  onNavigate,
  onRenameAddress,
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
  onRenameAddress: (rawKeys: string[], fromAddress: string, toAddress: string) => number;
  onDecisionsChanged: () => void;
  dataset: Dataset;
  /** Kept mounted but off screen while the other compliance tab is shown — a
   *  report costs a pass over the file, and switching tabs must not throw it
   *  away. */
  hidden?: boolean;
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

  const dismiss = async (f: AddressFinding) => {
    const key = addressDecisionKey(f.key);
    await putDecisions([{ key, status: REGISTER_DISMISSED, ts: Date.now() }]);
    setReport((prev) =>
      prev
        ? { ...prev, findings: prev.findings.map((o) => (o.key === f.key ? { ...o, dismissed: true } : o)) }
        : prev,
    );
    onDecisionsChanged();
  };

  const takeOfficial = (f: AddressFinding) => {
    if (!f.officialAddress) return;
    setApplied(onRenameAddress(f.rawKeys, f.written, f.officialAddress));
    // The row is answered; drop it rather than leave it claiming a
    // disagreement the file no longer has.
    setReport((prev) => (prev ? { ...prev, findings: prev.findings.filter((o) => o.key !== f.key) } : prev));
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

    // One chip per country the findings stand in — the place value's last comma
    // part, the key the places compliance list and both geocoding lists chip on,
    // so all four say the same thing about the same file. Shown even where the
    // file names a single country: which country was held against which register
    // is worth stating outright, and a filter row that comes and goes with the
    // data reads as a glitch rather than as a choice.
    const countries: string[] = [];
    for (const f of pool) {
      const c = countryOf(f.place);
      if (!countries.includes(c)) countries.push(c);
    }
    const activeCountry = countryFilter !== null && countries.includes(countryFilter) ? countryFilter : null;
    const inCountry = (f: AddressFinding) => activeCountry === null || countryOf(f.place) === activeCountry;
    const countryChips = countries.map((code) => ({
      code,
      unknown: !code,
      count: matched.filter((f) => countryOf(f.place) === code && inVerdict(f)).length,
    }));
    countryChips.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
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
    const byPlace = new Map<string, AddressFinding[]>();
    for (const f of rows) {
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

  const allGroupsOpen = !!view && view.groups.length > 0 && view.groups.every((g) => openGroups.has(g.place));

  return (
    <section className="tools-cleanup-section" style={hidden ? { display: "none" } : undefined}>
      <p className="tools-intro">{t("tools.registerAddr.intro")}</p>

      {!report && (
        <p className="tools-fix-hint">
          <button className="nav-btn tools-run" disabled={!!running} onClick={() => void run()}>
            {running
              ? t("tools.registerAddr.running", { done: running.done, total: running.total })
              : t("tools.registerAddr.check", { count: askable.length })}
          </button>
        </p>
      )}

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
              <div className="tools-chips">
                <button
                  className={`tools-chip ${view.activeCountry === null ? "active" : ""}`}
                  onClick={() => setCountryFilter(null)}
                >
                  {t("tools.geocode.filter.all")} <span className="tools-chip-count">{view.countryAll}</span>
                </button>
                {view.countryChips.map((c) => (
                  <button
                    key={c.code || "?"}
                    className={`tools-chip ${view.activeCountry === c.code ? "active" : ""}`}
                    onClick={() => setCountryFilter(c.code)}
                  >
                    {c.unknown ? t("tools.geocode.countryUnknown") : c.code}{" "}
                    <span className="tools-chip-count">{c.count}</span>
                  </button>
                ))}
              </div>
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
                  allOpen={allGroupsOpen}
                  onToggle={() => {
                    if (allGroupsOpen) {
                      setOpenGroups(new Set());
                      setOpen(new Set());
                      setPeopleOpen(new Set());
                    } else setOpenGroups(new Set(view.groups.map((g) => g.place)));
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
              <AppliedNote count={applied} />
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
                      <span className="tools-geo-count">
                        {t("tools.registerAddr.groupMeta", { count: group.findings.length })}
                      </span>
                    </GeoRowHeader>
                    {groupOpen && (
                    <ul className="tools-tree">
                {group.findings.map((f) => {
                  // What a row has to disclose: where the register files this
                  // house, or — for a spelling — the register's own full line
                  // behind the address that would replace it. A number the
                  // register lacks says all it has to say on the header line.
                  const hasDetail = (f.verdict === "addrElsewhere" && !!f.officialPlace) || !!f.officialAddress;
                  const showPeople = peopleOpen.has(f.key);
                  const isOpen = (hasDetail && open.has(f.key)) || showPeople;
                  return (
                    <li key={f.key} className={`tools-tree-node${f.dismissed ? " dismissed" : ""}`}>
                      {/* The shape the places findings use: the value the file
                          writes leads with the place it sits in beside it, the
                          register's answer follows, and the verdict, the
                          actions and the person count are pinned right, so the
                          eye runs down two clean columns. */}
                      <GeoRowHeader
                        open={isOpen}
                        caret={hasDetail}
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
                            as the answer this is drawn from. A row with nothing
                            to write shows the register's line itself: there the
                            register's own words are the whole finding. */}
                        {(f.officialAddress ?? f.official) && (
                          <>
                            <span aria-hidden="true" className="tools-register-place">→</span>
                            <span className="tools-geo-cand-name">{f.officialAddress ?? f.official}</span>
                          </>
                        )}
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
                              onClick={() => takeOfficial(f)}
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
                          {/* Where the register would put these events. Named
                              rather than done: the move belongs on the Addresses
                              tab, which has the map to check the house on before
                              anything is written. */}
                          {open.has(f.key) && f.verdict === "addrElsewhere" && f.officialPlace && (
                            <p className="tools-fix-hint" title={t("tools.registerAddr.moveHint")}>
                              {t("tools.registerAddr.move", { place: f.officialPlace })}
                            </p>
                          )}
                          {/* The register's own answer, in the shape every other
                              geocoding list shows an answer in — one option to
                              take or leave. Taking it writes the address above,
                              which is this line minus the post code and plus
                              whatever note the file's own value ends with. */}
                          {open.has(f.key) && f.officialAddress && f.official && (
                            <ul className="tools-geo-candidates">
                              <li>
                                <label>
                                  <input
                                    type="radio"
                                    className="tools-geo-cand-radio"
                                    name={`registerAddr-${f.key}`}
                                    aria-label={f.official}
                                    disabled={f.dismissed}
                                    checked={false}
                                    onChange={() => takeOfficial(f)}
                                  />
                                  <span className="tools-geo-cand-name">{f.official}</span>
                                </label>
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
                <p className="tools-clean">{t("tools.geocode.more", { count: view.rows.length - MAX_ROWS })}</p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

