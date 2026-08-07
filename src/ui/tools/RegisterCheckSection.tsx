import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { deleteDecision, putDecisions } from "../../persist/geoDb";
import { countryOf, pickLabel, type FileCoord, type OfficialRename } from "../../tools/geocode";
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
import { proposalFromGazEntry, type PlaceStyle } from "../../geo/placeProposal";
import { AppliedNote, ExpandAllToggle, GeoPeopleList, GeoRowHeader, MapToggle, RowMap } from "./shared";
import { PlaceAutocomplete } from "../edit/PlaceAutocomplete";
import type { MiniMapPin } from "../map/MiniPlaceMap";
import type { Dataset } from "../../gedcom/types";
import type { KinshipResolver } from "../../match/kinship";
import { searchGazetteer, type GazEntry, type GazetteerIndex } from "../../geo/gazetteer";

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
/**
 * Verdicts whose answer a bulk rename never sweeps on its own. Each row still
 * arrives on its answer and offers to write it — the reader sees what would
 * change and takes it with one click — but "Use official names" passes them by
 * until the row is picked by hand.
 *
 * These are corrections to the *record* rather than to the register's wording
 * of a place: a county standing in for the village in it, or a level left
 * blank, is a habit as much as a mistake, and one worth reading before writing.
 *
 * `address` joins them for a sharper reason. It does not reword a value, it
 * takes text out of PLAC and writes it on the event's own ADDR line — and what
 * it reads as a house is a value ending in a number, which a US census file
 * trips on every row: "Justice Precinct 4", "Detroit Ward 19", "Ward 3" are
 * enumeration districts, and no bulk action should turn twenty-eight of them
 * into street addresses because they end in a digit. Offered per row, where the
 * reader can see it is a precinct; never swept.
 */
const BULK_HELD_BACK: RegisterVerdict[] = ["region", "notFound", "address"];

const BADGE: Record<RegisterVerdict, string> = {
  notFound: "remove",
  region: "new",
  ambiguous: "reuse",
  admin: "remove",
  spelling: "official",
  site: "new",
  address: "new",
  far: "reuse",
};

export function RegisterCheckSection({
  report,
  dataset,
  onRename,
  placeSug,
  index,
  style,
  kinship,
  onNavigate,
  fileCoords,
  query,
  actionsHost,
  onApplyOfficialNames,
  onDecisionsChanged,
}: {
  /** The check's result, or null while no official register is loaded. */
  report: RegisterCheckReport | null;
  dataset: Dataset;
  /** The loaded directories, for the wider search a row can ask for. */
  index: GazetteerIndex | undefined;
  /** How this file writes places — the layout every register answer here is
   *  shown in, so the reader compares like with like. */
  style: PlaceStyle;
  /** Kinship labels for a row's people list — the places rows' resolver. */
  kinship?: KinshipResolver;
  /** Jump to a person in Edit mode (the people list). */
  onNavigate: (id: string) => void;
  /** Every coordinate the file carries — context dots on a row's map. */
  fileCoords: FileCoord[];
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
  /** Rename every occurrence of exactly this raw place value. The register's
   *  own spelling is one click away, but a finding is often the prompt to write
   *  a correction of your own — a historical name spelt as the parish wrote it,
   *  a level the register has no opinion about. */
  onRename: (from: string, to: string) => void;
  /** The file's own place values, for the rename box's completions. */
  placeSug: { placeSuggestions: string[]; placeCanonical: Map<string, string> };
}) {
  const { t } = useTranslation();
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
  /** The one row whose map is mounted — one Leaflet instance for the list, so
   *  opening another row's map takes it from the first. */
  const [mapOpen, setMapOpen] = useState<string | null>(null);
  /** Answers a row asked for beyond the ones its name matches outright — see
   *  {@link searchWider}. Kept per row, since each is its own question. */
  const [wider, setWider] = useState<Map<string, GazEntry[]>>(new Map());
  /** The row whose name is being edited, and the text so far. One at a time:
   *  the box replaces the row's own line, so two open at once would be two
   *  rows claiming the same edit. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  /** Write the edited name over every occurrence of the row's raw value, and
   *  close the box. A draft that says nothing new is simply a cancel. */
  const applyRename = (from: string) => {
    const to = renameDraft.trim();
    if (to && to !== from) onRename(from, to);
    setRenaming(null);
  };

  /**
   * Widen a row's answers: every place in the loaded directories whose name
   * merely *contains* the written one — "Bela" finding Spodnja, Srednja and
   * Zgornja Bela, or "Vrh" the dozen names built on it — and then those that
   * merely resemble it, which is the only way a misspelling is ever found:
   * nothing relates "Mrkopolje" to the register's "Mrkopalj" by substring.
   *
   * Searched under the row's whole value, not its locality alone, so the
   * country it names bounds the answers the way it bounds the check itself.
   *
   * Not offered by default, and not offered for every row: the check holds a
   * name to a letter-for-letter match, which is what keeps it from claiming
   * that "Slovenia" is a misspelt "Šlovrenc", and a name that is one word of a
   * longer name is a lead rather than an answer. It is also a scan of every
   * entry in every directory (a quarter of a million rows for a GeoNames
   * country), which is affordable on one row's click and not per place in the
   * file. The same search, on the same terms, that the place fields in Edit
   * offer.
   */
  const searchWider = (f: RegisterFinding, known: RegisterOption[]) => {
    if (!index) return;
    const seen = new Set(known.map((o) => (o.entry ? `${o.entry.name}:${o.entry.lat}:${o.entry.lon}` : o.place)));
    // 18, not a screenful less: a short name collects many exact and prefix
    // hits across directories ("Bela" has a dozen), and the qualified villages
    // the search exists to surface — "Srednja Bela", "Zgornja Bela" — rank
    // below all of them, so a tight cap cut off exactly the useful rows.
    const found = searchGazetteer(index, f.key, 18, true).filter(
      (e) => !seen.has(`${e.name}:${e.lat}:${e.lon}`),
    );
    setWider((prev) => new Map(prev).set(f.key, found));
  };

  const toggleOpen = (key: string) => {
    const willOpen = !open.has(key);
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
    // Which of six same-named places is the one is a question for the map, so a
    // row opened by hand arrives with it — as an Edit coordinate panel does.
    // Expand all, and the people count, leave it to the toggle.
    setMapOpen((prev) => (willOpen ? key : prev === key ? null : prev));
  };
  const togglePeople = (key: string) => {
    setPeopleOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
    setOpen((prev) => new Set(prev).add(key));
  };
  const pick = (key: string, index: number) => setPicked((prev) => new Map(prev).set(key, index));
  // A checked radio fires no change event, so taking a pick back needs the
  // click itself — the same pattern as the places and addresses tabs. Without
  // it a mispick on an `ambiguous` row is irrevocable and silently joins the
  // bulk-rename count.
  const unpick = (key: string) =>
    setPicked((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });

  // A rename, an undo or an edit elsewhere re-runs the check, and the rows it
  // settles leave the list. Their open state and picks go with them — the same
  // sweep the other lists on this page make after a rescan.
  useEffect(() => {
    if (!report) return;
    const keys = new Set(report.findings.map((f) => f.key));
    setOpen((prev) => new Set([...prev].filter((k) => keys.has(k))));
    setPeopleOpen((prev) => new Set([...prev].filter((k) => keys.has(k))));
    setPicked((prev) => new Map([...prev].filter(([k]) => keys.has(k))));
    setMapOpen((prev) => (prev && keys.has(prev) ? prev : null));
    setWider((prev) => new Map([...prev].filter(([k]) => keys.has(k))));
  }, [report]);

  // Two chip rows, faceted the way the places list's are: a chip's count
  // respects every filter except its own row's, so the number on it is exactly
  // how many rows clicking it puts on screen.
  const view = useMemo(() => {
    if (!report) return null;
    const pool = report.findings.filter((f) => showDismissed || !f.dismissed);
    const searched = query ? pool.filter((f) => foldSearch(f.key).includes(query)) : pool;

    // One chip per country, read off the place value itself — its last comma
    // part, exactly as the places list reads its own country buttons, so the
    // two rows of chips say the same thing about the same file and a country is
    // named the way the file names it. A value that names no country goes under
    // "unspecified" rather than being filed under whichever country its answers
    // happen to be in: nothing in the file says it is there, and the whole point
    // of a row whose name fits four countries is that they are all still open.
    const countries: string[] = [];
    for (const f of pool) {
      const c = countryOf(f.key);
      if (!countries.includes(c)) countries.push(c);
    }
    const activeCountry = countryFilter !== null && countries.includes(countryFilter) ? countryFilter : null;
    const inCountry = (f: RegisterFinding) => activeCountry === null || countryOf(f.key) === activeCountry;
    const inVerdict = (f: RegisterFinding) => verdictFilter === "all" || f.verdict === verdictFilter;

    const countryChips = countries.map((code) => ({
      code,
      name: code,
      unknown: !code,
      count: searched.filter((f) => countryOf(f.key) === code && inVerdict(f)).length,
    }));
    countryChips.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const countryAll = searched.filter(inVerdict).length;

    const counts = Object.fromEntries(REGISTER_VERDICTS.map((v) => [v, 0])) as Record<RegisterVerdict, number>;
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
  }, [report, query, verdictFilter, countryFilter, showDismissed]);

  if (!report || !view) return null;

  /** The file's own FORM for a country's places, as the chip's tooltip. Empty
   *  for a country whose places carry none, which leaves the chip its plain
   *  self rather than an explanation of an absence. */
  const formOf = (country: string): string | undefined => {
    const form = report.forms.find((f) => f.country === country)?.form;
    return form ? `${t("tools.register.forms")} ${form}` : undefined;
  };

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
      // The label line the new value deserves, when the option taken is the
      // one the check proposed. A pick made from the register's other answers
      // carries no computed form, and the write then drops a stale one rather
      // than keeping a line naming levels the value no longer has.
      ...(f.officialForm && o.place === f.official ? { form: f.officialForm } : {}),
    };
  };

  /** What "Use official names" would write: every shown row that has an answer
   *  to take. A row whose several places nobody has chosen between is not one
   *  of them — that is the researcher's call, one row at a time — and neither
   *  is a row whose verdict is held back from the sweep until picked by hand. */
  const bulk = view.rows.flatMap((f) => {
    if (BULK_HELD_BACK.includes(f.verdict) && !picked.has(f.key)) return [];
    const options = optionsOf(f, style, wider.get(f.key));
    return renameFor(f, options, chosenIndex(f, options, picked)) ?? [];
  });
  const allOpen = view.rows.length > 0 && view.rows.every((f) => open.has(f.key));

  const dismiss = async (f: RegisterFinding) => {
    const key = registerDecisionKey(f.key);
    try {
      if (f.dismissed) await deleteDecision(key);
      else await putDecisions([{ key, status: REGISTER_DISMISSED, ts: Date.now() }]);
    } catch {
      // An IndexedDB failure was an unhandled rejection and the toggle
      // silently stayed put. There is nothing better to do than leave the row
      // as it is — the refresh below re-reads whatever state actually holds.
    }
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
      <AppliedNote count={applied} />
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
      {/* One line of standing: how much agrees, out of how much was looked at,
          against what — with the places nothing could judge counted at its end
          rather than given a paragraph of their own. */}
      <p className="tools-fix-hint">
        {summary}
        {report.skipped > 0 && (
          <>
            {" · "}
            <span title={t("tools.register.skippedHint")}>{t("tools.register.skipped", { count: report.skipped })}</span>
          </>
        )}
      </p>
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
                  // What this file calls the levels of *this* country's places —
                  // the answer to what every parent finding turns on, and the
                  // one thing here the file states and nothing else shows. It
                  // was a paragraph naming every country at once; a level naming
                  // is about one country at a time, and the chip is already
                  // that country.
                  title={formOf(c.code)}
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
            {/* Opening every row is a way of looking at the list, like the
                chips beside it — not one of the writes above. */}
            <ExpandAllToggle
              allOpen={allOpen}
              onToggle={() => {
                if (allOpen) {
                  setOpen(new Set());
                  setPeopleOpen(new Set());
                  setMapOpen(null);
                } else setOpen(new Set(view.rows.map((f) => f.key)));
              }}
            />
          </div>

          {!view.rows.length && <p className="tools-clean">{t("tools.search.noMatch")}</p>}
          <ul className="tools-tree tools-register-list">
            {view.rows.slice(0, MAX_ROWS).map((f) => {
              const options = optionsOf(f, style, wider.get(f.key));
              const chosen = chosenIndex(f, options, picked);
              const rename = renameFor(f, options, chosen);
              const isOpen = open.has(f.key) || peopleOpen.has(f.key);
              /** Whether the bulk rename waits for this row to be picked by
               *  hand — which is what its radio then marks. */
              const held = BULK_HELD_BACK.includes(f.verdict);
              return (
                <li key={f.key} className={`tools-tree-node${f.dismissed ? " dismissed" : ""}`}>
                  {/* The same row shape as the places and addresses lists: the
                      value the file writes leads, what the register answers
                      follows it, and the badge, the actions and the person
                      count sit at the end. */}
                  <GeoRowHeader open={isOpen} onToggle={() => toggleOpen(f.key)} place={f.key}>
                    {/* ✎ (U+270E), the same edit mark the places tree, the
                        addresses list and Organize sources use. It writes the
                        raw value the row is about, so it is the one action here
                        that does not go through the register at all — a finding
                        is often the prompt to spell something your own way. */}
                    {renaming === f.key ? (
                      <button
                        className="tools-place-edit-btn tools-place-edit-cancel"
                        onClick={() => setRenaming(null)}
                        title={t("tools.places.rename.cancel")}
                      >
                        ✕
                      </button>
                    ) : (
                      <button
                        className="tools-place-edit-btn"
                        onClick={() => {
                          setRenaming(f.key);
                          setRenameDraft(f.key);
                        }}
                        title={t("tools.geocode.renameOpen")}
                      >
                        ✎
                      </button>
                    )}
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
                          // Not .tools-geo-row-addr: that class draws the pin
                          // that marks a value as a house address, and what
                          // this row proposes to split off is only *shaped*
                          // like one — a value ending in a number. "Justice
                          // Precinct 4" and "Detroit Ward 19" are census
                          // districts, and a pin on them asserts a house.
                          <span className="tools-register-place">· {options[chosen].addr}</span>
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
                        {f.dismissed ? t("tools.geocode.restore") : t("tools.geocode.hide")}
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
                  {renaming === f.key && (
                    <div
                      className="tools-place-rename"
                      onKeyDown={(e) => {
                        // Enter with a highlighted suggestion, and Escape with
                        // an open dropdown, belong to the autocomplete; the next
                        // press reaches the editor.
                        if (e.key === "Enter" && !e.defaultPrevented) applyRename(f.key);
                        if (e.key === "Escape" && !e.defaultPrevented) setRenaming(null);
                      }}
                    >
                      <PlaceAutocomplete
                        value={renameDraft}
                        suggestions={placeSug.placeSuggestions}
                        canonical={placeSug.placeCanonical}
                        isDirty={false}
                        className="tools-place-rename-input"
                        wrapClassName="tools-place-rename-auto"
                        placeholder={t("tools.places.rename.placeholder")}
                        autoFocus
                        // A rename may be exactly a casing fix — the canonical
                        // map must not snap it back on blur.
                        preserveCase
                        onChange={setRenameDraft}
                        onCommit={setRenameDraft}
                        onClear={() => setRenameDraft("")}
                      />
                      <button className="tools-issue-link" onClick={() => applyRename(f.key)}>
                        {t("tools.places.rename.apply")}
                      </button>
                    </div>
                  )}
                  {isOpen && (
                    <div className="tools-geo-conflict-body">
                      {/* The register's answers, one numbered option per line —
                          the same list, and the same numbered radios, the
                          places and addresses rows offer their candidates in.
                          Picking one is what the rename then writes. */}
                      {/* Which of six same-named places is the one is a
                          question only a map answers, so the row draws its
                          answers as the numbered pins the option lines carry,
                          and the position the file records for the place beside
                          them — asked for by a click on any coordinate, or on
                          the toggle, and never drawn before that (Leaflet is a
                          lazy chunk). A row with neither has nothing to draw. */}
                      {(options.some((o) => o.entry) || f.fileCoord) && (
                          <div className="tools-geo-actions">
                            <MapToggle
                              open={mapOpen === f.key}
                              onToggle={() => setMapOpen(mapOpen === f.key ? null : f.key)}
                            />
                            {/* A name that is one word of a longer one is a
                                lead, not an answer, so the wider search is
                                asked for rather than run for every place. */}
                            {!wider.has(f.key) && (
                              <button
                                className="tools-issue-link"
                                onClick={() => searchWider(f, options)}
                                title={t("tools.register.widerHint")}
                              >
                                {t("tools.register.wider")}
                              </button>
                            )}
                            {wider.get(f.key)?.length === 0 && (
                              <span className="tools-geo-count">{t("tools.register.widerNone")}</span>
                            )}
                          </div>
                      )}
                      {mapOpen === f.key && (
                            <RowMap
                              // The wider search adds pins that can sit far
                              // outside the fitted view — re-frame when its
                              // results land (same idea as the places row).
                              fitKey={`${f.key}:${wider.get(f.key)?.length ?? 0}`}
                              context={fileCoords}
                              pins={[
                                  ...options.flatMap((o, i): MiniMapPin[] =>
                                    o.entry
                                      ? [
                                          {
                                            coord: { lat: o.entry.lat, lon: o.entry.lon },
                                            label: o.place,
                                            lines: [directoryOf(o.entry), t("event.coord.pinPick")],
                                            badge: i + 1,
                                            kind: chosen === i ? "chosen" : "candidate",
                                            onPick: () => pick(f.key, i),
                                          },
                                        ]
                                      : [],
                                  ),
                                  // Where the file itself puts the place, so a
                                  // coordinate reported as off is read against
                                  // the answers rather than taken on trust.
                                  ...(f.fileCoord
                                    ? [
                                        {
                                          coord: f.fileCoord,
                                          label: t("tools.register.currentPin"),
                                          lines: [f.key],
                                          kind: "candidate" as const,
                                          area: true,
                                        },
                                      ]
                                    : []),
                                ]}
                            />
                          )}
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
                                    // A verdict the sweep holds back starts
                                    // with an *empty* circle, however plainly
                                    // the row shows what it would write: what
                                    // the circle marks here is "I have read
                                    // this and agree", which is the whole
                                    // reason those two wait. Filled by default
                                    // it asked to be confirmed by a click that
                                    // looked as though it had already been
                                    // made — and the row then sat out of "Use
                                    // official names" with no way to say so.
                                    checked={held ? picked.get(f.key) === i : chosen === i}
                                    onChange={() => pick(f.key, i)}
                                    // Only an explicit pick can be taken back
                                    // by clicking it again. A row arrives with
                                    // its answer already *shown* as chosen
                                    // without being picked (see chosenIndex),
                                    // and a checked radio fires no change
                                    // event — so reading that click as "take it
                                    // back" left the one verdict that waits to
                                    // be picked by hand unable to be picked at
                                    // all: it stayed out of "Use official
                                    // names" however often it was clicked.
                                    onClick={() => (picked.get(f.key) === i ? unpick(f.key) : pick(f.key, i))}
                                  />
                                  <span className="tools-geo-cand-num">{i + 1}</span>
                                  <span className="tools-geo-cand-name">{o.place}</span>
                                  {/* The house the split moves onto the event's
                                      own ADDR line, shown where it will land. */}
                                  {o.addr && <span className="tools-register-place">ADDR: {o.addr}</span>}
                                  {o.entry && (
                                    <>
                                      {/* The coordinate opens the map on this
                                          answer's pin — the number beside the
                                          line is the number on the pin. */}
                                      <button
                                        type="button"
                                        className="tools-geo-coord-btn gm-data gm-coord"
                                        title={t("tools.register.showOnMap")}
                                        onClick={(e) => {
                                          e.preventDefault();
                                          setMapOpen(mapOpen === f.key ? null : f.key);
                                        }}
                                      >
                                        {o.entry.lat.toFixed(4)}, {o.entry.lon.toFixed(4)}
                                      </button>
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
                      {/* A row with no answer to offer says why, in the body's
                          own quiet voice — `tools-clean` is the page's "nothing
                          to report" line and brings a paragraph's padding with
                          it. */}
                      {!options.length && <p className="tools-fix-hint">{t(`tools.register.hint.${f.verdict}`)}</p>}
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
  /** Turned up by the wider search rather than by the check itself — a lead to
   *  judge, never an answer, so it is never the option a row arrives on. */
  wide?: true;
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
function optionsOf(f: RegisterFinding, style: PlaceStyle, wider?: readonly GazEntry[]): RegisterOption[] {
  // Places found by a wider search stand after the answers the name matched
  // outright, in the order the search ranked them.
  const widened = (wider ?? []).map((entry) => ({ entry, place: placeTextOf(entry, style), wide: true as const }));
  if (f.verdict === "ambiguous") {
    return [...(f.alternatives ?? []).map((entry) => ({ entry, place: placeTextOf(entry, style) })), ...widened];
  }
  if ((f.verdict === "spelling" || f.verdict === "admin") && f.entry) {
    return [{ entry: f.entry, place: f.official ?? placeTextOf(f.entry, style) }, ...widened];
  }
  if (f.verdict === "site" && f.entry && f.official) {
    return [{ entry: f.entry, place: f.official, ...(f.officialAddr ? { addr: f.officialAddr } : {}) }, ...widened];
  }
  // A name the directory knows as a county, and an unknown one carrying a level
  // that says nothing, both answer with the value one level shorter. There is
  // no register entry behind it: the correction is to the writing, not a place.
  if ((f.verdict === "region" || f.verdict === "notFound") && f.official) {
    return [{ place: f.official }, ...widened];
  }
  if (f.verdict === "notFound" || f.verdict === "region") return widened;
  // The place/address split: the settlement left in PLAC, the house on its own
  // ADDR line, both already shaped by the file's own layout.
  if (f.verdict === "address" && f.official && f.officialAddr) {
    return [{ place: f.official, addr: f.officialAddr }];
  }
  return [];
}

/**
 * The answer the row stands on: the researcher's pick, else the answer the
 * check itself arrived at — the register's wording of the place, which is the
 * whole finding on every verdict but one.
 *
 * `ambiguous` is that one: several places fit the name and nothing chooses
 * between them, so the row waits. A wider search adds leads to any row without
 * ever making one of them the answer, which is why this reads the verdict
 * rather than counting the options.
 */
function chosenIndex(f: RegisterFinding, options: RegisterOption[], picked: ReadonlyMap<string, number>): number {
  const own = picked.get(f.key);
  if (own !== undefined && own < options.length) return own;
  // `site` joins `ambiguous` in waiting: a cemetery written into the place is a
  // habit as much as a mistake, and which level to move is the whole question.
  // Everything else arrives on its answer, so the row shows what it would
  // write. Whether a bulk rename may *sweep* that answer is a separate question
  // — see BULK_HELD_BACK.
  //
  // A wider lead is never that answer: it is a name that merely resembles or
  // contains the written one, and a row must not arrive already claiming one.
  if (f.verdict === "ambiguous" || f.verdict === "site") return -1;
  return options.length > 0 && !options[0].wide ? 0 : -1;
}

function placeTextOf(entry: GazEntry, style: PlaceStyle): string {
  return proposalFromGazEntry(entry, style)?.plac ?? pickLabel(entry.name, entry.admin);
}
