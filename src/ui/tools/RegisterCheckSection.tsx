import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { deleteDecision, putDecisions } from "../../persist/geoDb";
import { pickLabel, type OfficialRename } from "../../tools/geocode";
import {
  registerDecisionKey,
  REGISTER_DISMISSED,
  REGISTER_VERDICTS,
  type RegisterCheckReport,
  type RegisterFinding,
  type RegisterVerdict,
} from "../../tools/registerCheck";
import { foldSearch } from "../globalSearch";
import { countryNameOf } from "../../geo/placeProposal";

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
  far: "reuse",
};

export function RegisterCheckSection({
  report,
  query,
  actionsHost,
  onApplyOfficialNames,
  onDecisionsChanged,
}: {
  /** The check's result, or null until the tab has been opened — it looks up
   *  every place in the file, which is work no one asked for while another tab
   *  is on screen. */
  report: RegisterCheckReport | null;
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

    const countryChips = countries.map((code) => ({
      code,
      name: countryNameOf(code, i18n.language) ?? code,
      count: searched.filter((f) => f.country === code && inVerdict(f)).length,
    }));
    countryChips.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const countryAll = searched.filter(inVerdict).length;

    const counts = { notFound: 0, ambiguous: 0, admin: 0, spelling: 0, far: 0 };
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

  /** The rename a spelling row offers: to the register's name, keeping every
   *  outer level the file writes. Absent when the value's leading segment is
   *  not its settlement — there is nothing safe to swap then. */
  const renameFor = (f: RegisterFinding): OfficialRename | undefined =>
    f.verdict === "spelling" && f.official && f.entry && !f.dismissed
      ? { from: f.key, to: f.official, assignment: { coord: { lat: f.entry.lat, lon: f.entry.lon } } }
      : undefined;

  const bulk = view.rows.flatMap((f) => renameFor(f) ?? []);

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
                  {c.name} <span className="tools-chip-count">{c.count}</span>
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
          <ul className="tools-tree">
            {view.rows.slice(0, MAX_ROWS).map((f) => {
              const rename = renameFor(f);
              return (
                <li key={f.key} className={`tools-tree-node tools-register-row${f.dismissed ? " dismissed" : ""}`}>
                  <span className={`tools-reshape-badge ${BADGE[f.verdict]}`}>{t(`tools.register.verdict.${f.verdict}`)}</span>
                  <span className="tools-geo-cand-name">{f.key}</span>
                  <span className="tools-geo-count">{t("tools.geocode.addr.uses", { count: f.count })}</span>
                  <span className="tools-register-detail">{detailOf(f, t)}</span>
                  <span className="tools-register-actions">
                    {rename && (
                      <button
                        className="tools-issue-link"
                        onClick={() => setApplied(onApplyOfficialNames([rename]))}
                        title={t("tools.geocode.official.tooltip", { name: f.entry!.name })}
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
                  </span>
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

/** What the row says about the disagreement — one line, the register's side of
 *  it: the name it uses, the municipality it files the place under, the places
 *  a name fits, or how far the file's coordinate sits from its position. */
function detailOf(f: RegisterFinding, t: (key: string, opts?: Record<string, unknown>) => string): string {
  switch (f.verdict) {
    case "notFound":
      return t("tools.register.detail.notFound");
    case "ambiguous":
      return t("tools.register.detail.ambiguous", {
        places: (f.alternatives ?? []).map((e) => pickLabel(e.name, e.admin)).join(" · "),
      });
    case "admin":
      return t("tools.register.detail.admin", { admin: f.entry?.admin ?? "", written: f.writtenAdmin ?? "" });
    case "spelling":
      return t("tools.register.detail.spelling", { name: pickLabel(f.entry!.name, f.entry!.admin) });
    case "far":
      return t("tools.register.detail.far", {
        km: Math.round(f.distanceKm ?? 0),
        name: pickLabel(f.entry!.name, f.entry!.admin),
      });
  }
}
