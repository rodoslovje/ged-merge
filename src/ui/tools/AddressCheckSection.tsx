import { useMemo, useState } from "react";
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
import { REGISTER_DISMISSED } from "../../tools/registerCheck";
import { useLocalRegisters } from "../useLocalRegisters";
import { AppliedNote, GeoPeopleList } from "./shared";

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

/** Addresses resolved per pass, so a long file fills in rather than freezing. */
const CHUNK = 200;

/** Rows drawn at once; the rest wait behind the page search, as every list on
 *  this page does. */
const MAX_ROWS = 300;

export function AddressCheckSection({
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
}) {
  const { t } = useTranslation();
  useLocalRegisters();
  const [report, setReport] = useState<AddressCheckReport | null>(null);
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);
  const [verdictFilter, setVerdictFilter] = useState<"all" | AddressVerdict>("all");
  const [showDismissed, setShowDismissed] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState<Set<string>>(new Set());
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

  const view = useMemo(() => {
    if (!report) return null;
    // The aside verdict is off the default list on purpose — see addressCheck.
    // Its chip is the only way in, which is also what makes the count honest.
    const pool = report.findings.filter(
      (f) =>
        (showDismissed || !f.dismissed) &&
        (verdictFilter === ADDRESS_ASIDE ? f.verdict === ADDRESS_ASIDE : f.verdict !== ADDRESS_ASIDE),
    );
    const counts = { addrElsewhere: 0, addrSpelling: 0, addrMissing: 0 };
    for (const f of report.findings) if (showDismissed || !f.dismissed) counts[f.verdict]++;
    const matched = query
      ? pool.filter((f) => foldSearch(f.place).includes(query) || foldSearch(f.written).includes(query))
      : pool;
    return {
      rows: verdictFilter === "all" || verdictFilter === ADDRESS_ASIDE ? matched : matched.filter((f) => f.verdict === verdictFilter),
      counts,
      all: counts.addrElsewhere + counts.addrSpelling,
      dismissedTotal: report.findings.filter((f) => f.dismissed).length,
    };
  }, [report, query, verdictFilter, showDismissed]);

  // Nothing stored for any country the file writes: the check cannot be made,
  // and a disabled button explaining why would only be a second copy of the
  // download it wants (Settings › Map). Say nothing at all.
  if (!askable.length) return null;

  return (
    <section className="tools-cleanup-section">
      <div className="tools-dup-kind-head">
        {t("tools.registerAddr.heading")}
        {report && <span className="tools-chip-count">{report.findings.length}</span>}
      </div>
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
              <ul className="tools-tree tools-register-list">
                {view.rows.slice(0, MAX_ROWS).map((f) => (
                  <li key={f.key} className={`tools-tree-node${f.dismissed ? " dismissed" : ""}`}>
                    <div className="tools-geo-addr-line">
                      <span className="tools-geo-addr-name gm-data">{f.written}</span>
                      <span className="tools-geo-addr-place">{f.place}</span>
                      {f.official && (
                        <>
                          <span aria-hidden="true">→</span>
                          <span className="tools-reshape-to gm-data">{f.official}</span>
                        </>
                      )}
                      <span className={`tools-reshape-badge ${f.verdict === ADDRESS_ASIDE ? "" : "official"}`}>
                        {t(`tools.registerAddr.verdict.${f.verdict}`)}
                      </span>
                      <button
                        className="tools-geo-count tools-geo-people-toggle"
                        onClick={() =>
                          setPeopleOpen((prev) => {
                            const next = new Set(prev);
                            if (next.has(f.key)) next.delete(f.key);
                            else next.add(f.key);
                            return next;
                          })
                        }
                      >
                        {t("tools.geocode.addr.uses", { count: f.count })}
                      </button>
                      {f.officialAddress && !f.dismissed && (
                        <button className="tools-issue-link" onClick={() => takeOfficial(f)}>
                          {t("tools.registerAddr.take")}
                        </button>
                      )}
                      {/* The move belongs to the Addresses tab, which has the
                          machinery for it (and the map to check it on). Named
                          here, done there. */}
                      {f.verdict === "addrElsewhere" && f.officialPlace && (
                        <span className="tools-geo-online-note" title={t("tools.registerAddr.moveHint")}>
                          {t("tools.registerAddr.move", { place: f.officialPlace })}
                        </span>
                      )}
                      {!f.dismissed && (
                        <button
                          className="tools-issue-link"
                          title={t("tools.register.dismissHint")}
                          onClick={() => void dismiss(f)}
                        >
                          {t("tools.geocode.hide")}
                        </button>
                      )}
                    </div>
                    {peopleOpen.has(f.key) && (
                      <GeoPeopleList
                        dataset={dataset}
                        ids={f.people}
                        place={f.place}
                        kinship={kinship}
                        onNavigate={onNavigate}
                      />
                    )}
                  </li>
                ))}
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

