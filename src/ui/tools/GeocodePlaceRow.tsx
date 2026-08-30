import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, GeoCoord } from "../../gedcom/types";
import { formatCoord, sameCoord } from "../../geo/points";
import type { GazCandidate } from "../../geo/gazetteer";
import { placeLookupLanguage } from "../../geo/lookupLanguage";
import { osmKindLabel, searchNominatim, type NominatimResult } from "../../geo/nominatim";
import { searchGov, type GovResult } from "../../geo/gov";
import { isOfflineQuery, rnQueriesFrom, searchAddresses, type RnResult } from "../../geo/rn";
import { IDLE_LOOKUP, type LookupState } from "../../geo/lookup";
import { useLocalRegisters } from "../useLocalRegisters";
import { adminOf, chosenCoordFor, pickLabel, type ChosenCoord, type FileCoord, type GeoAssignment, type GeocodeRow } from "../../tools/geocode";
import { replaceLocality } from "../../tools/addresses";
import type { KinshipResolver } from "../../match/kinship";
import { PlaceAutocomplete } from "../edit/PlaceAutocomplete";
import { usePlaceLookup } from "../edit/PlaceLookupContext";
import { placeKey, type PlaceSuggestions } from "../edit/placeSuggestions";
import type { PlaceProposal } from "../../geo/placeProposal";
import { placeCollator } from "../../gedcom/place";
import { useSettingsSlice } from "../SettingsContext";
import { EventCoordPicker } from "../edit/EventCoordPicker";
import { LookupAction } from "../edit/LookupAction";
import { GeoPeopleList, GeoRowHeader, MapToggle, RenameEditor } from "./shared";

// One row of the Geocode-places review list: the raw PLAC value, its badge
// (file coordinate / score / remembered / no-match), the rename editor, and —
// expanded — the mini map plus the radio list of coordinate options and the
// people the unresolved value belongs to. Draft state that concerns only this
// row (rename and manual-coordinate inputs) lives here, so typing in one row
// doesn't re-render the whole list; the actual review state (checked, chosen,
// no-match, expanded) stays with the panel — it must survive rescans and
// drive the apply pass.

/** The preferences this file reads — subscribed field by field, so an
 *  unrelated one changing leaves it alone (see useSettingsSlice). */
const SETTINGS_KEYS = ["allowLinkFetch"] as const;

/** Badge class for a match score: green when it is going in (confident or
 *  hand-checked), orange below 100% — the name did not match letter-perfectly,
 *  so the score should read as a caution — grey otherwise. */
function scoreBadgeClass(score: number, confident: boolean): string {
  const exact = Math.round(score * 100) >= 100;
  return `tools-geo-score${confident ? " confident" : exact ? "" : " warn"}${exact ? " exact" : ""}`;
}

interface Props {
  row: GeocodeRow;
  dataset: Dataset;
  isOpen: boolean;
  /** This row currently owns the single mounted mini map. */
  hasMap: boolean;
  /** The row is marked "no match". */
  marked: boolean;
  /** The user's explicit pick for this row, when any (panel-owned). */
  override?: ChosenCoord;
  /** Context dots for the mini map: every coordinate the file carries. */
  fileCoords: FileCoord[];
  /** Suggestions for the rename input (the Edit fields' lists). */
  placeSug: PlaceSuggestions;
  placeCombos: { place: string; addr: string }[];
  kinship?: KinshipResolver;
  /** Hover list of the people this place is missing at (precomputed). */
  missingInTitle?: string;
  onToggleOpen: (key: string) => void;
  onToggleMap: (key: string) => void;
  /** Choose a coordinate for the row; `govId` is set only for GOV picks and
   *  drives the `_GOV` write-back. */
  onPickCoord: (row: GeocodeRow, coord: GeoCoord, label: string, govId?: string) => void;
  /** Clicking the chosen option again drops the pick — a radio group has no
   *  "none" of its own, and a row picked by mistake would otherwise be written. */
  onUnpickCoord: (row: GeocodeRow) => void;
  onToggleNoMatch: (key: string) => void;
  /** Rename all occurrences of the row's raw value (with an optional
   *  place/ADDR split); the panel applies it and rescans. `coord` comes from a
   *  register offer picked in the input and places the renamed value at once. */
  onRename: (from: string, to: string, addr?: string, coord?: GeoAssignment) => void;
  onNavigate: (id: string) => void;
  /** This row's on-demand lookup results, owned by the panel: the list is
   *  virtualized, so a row scrolled out of the window unmounts — results held
   *  here (and half-spent rate-limited requests with them) must survive that,
   *  the way AddressCoordsSection already keeps its rows' searches. */
  lookups?: RowLookups;
  onLookupsChange: (key: string, patch: Partial<RowLookups>) => void;
}

/** A row's three on-demand lookups (absent = never asked). */
export interface RowLookups {
  online?: LookupState<NominatimResult>;
  gov?: LookupState<GovResult>;
  rn?: LookupState<RnResult>;
}

export function GeocodePlaceRow({
  row,
  dataset,
  isOpen,
  hasMap,
  marked,
  override,
  fileCoords,
  placeSug,
  placeCombos,
  kinship,
  missingInTitle,
  onToggleOpen,
  onToggleMap,
  onPickCoord,
  onUnpickCoord,
  onToggleNoMatch,
  onRename,
  onNavigate,
  lookups,
  onLookupsChange,
}: Props) {
  const { t, i18n } = useTranslation();
  const appSettings = useSettingsSlice(SETTINGS_KEYS);
  const lookup = usePlaceLookup();

  // What the row offers: its pick, else the coordinate it proposes by default.
  // Only a pick is written — `override` is that pick — so everything here that
  // says "going in" reads it rather than `c`.
  const c = chosenCoordFor(row, override, { fromFile: t("tools.geocode.fromFile") });

  // "Use official name": offered when the row resolves to a register candidate
  // whose name is not the letter-for-letter value the file writes — the
  // parent-qualified longer names above all ("Cerovec" under Semič → "Cerovec
  // pri Črešnjevcu"), but also a casing fix. One click renames every
  // occurrence and writes the candidate's coordinate.
  const officialCand =
    c && row.candidates.find((cand) => sameCoord(c.coord, { lat: cand.entry.lat, lon: cand.entry.lon }));
  const officialTo = officialCand ? replaceLocality(row.key, officialCand.entry.name) : undefined;

  // On-demand Nominatim (OSM) search for this row's raw value — the online
  // fallback for strings the offline gazetteer can't resolve, above all
  // street addresses. Behind the online opt-in; the query text leaves the
  // device, so it only ever runs from this explicit button.
  const online: LookupState<NominatimResult> = lookups?.online ?? IDLE_LOOKUP;
  const runOnlineSearch = () => {
    onLookupsChange(row.key, { online: { state: "loading", results: [] } });
    // In the language this place value is written in — see placeLookupLanguage.
    searchNominatim(row.key, placeLookupLanguage(row.key, i18n.language)).then(
      (results) => onLookupsChange(row.key, { online: { state: "done", results } }),
      () => onLookupsChange(row.key, { online: { state: "error", results: [] } }),
    );
  };

  // GOV (gov.genealogy.net) — the genealogy gazetteer with time-valid,
  // multilingual historical names and a stable GOV id. Same online opt-in and
  // explicit-button model as Nominatim; accepting a GOV match also writes the
  // GEDCOM-L `_GOV` id into the file.
  const gov: LookupState<GovResult> = lookups?.gov ?? IDLE_LOOKUP;
  const runGovSearch = () => {
    onLookupsChange(row.key, { gov: { state: "loading", results: [] } });
    // GOV holds each place's name in several languages and picks one by this
    // argument, so it follows the file's language for the same reason.
    searchGov(row.key, placeLookupLanguage(row.key, i18n.language)).then(
      (results) => onLookupsChange(row.key, { gov: { state: "done", results } }),
      () => onLookupsChange(row.key, { gov: { state: "error", results: [] } }),
    );
  };

  // GURS address register — the official Slovenian house-number gazetteer. Only
  // offered when this row's place value actually carries a house number, since
  // that is what the register resolves; the settlement alone is the offline
  // gazetteer's job. Same online opt-in and explicit-button model as the others.
  const rnQueries = useMemo(() => rnQueriesFrom(row.key, undefined), [row.key]);
  const rn: LookupState<RnResult> = lookups?.rn ?? IDLE_LOOKUP;
  const runRnSearch = () => {
    if (!rnQueries.length) return;
    onLookupsChange(row.key, { rn: { state: "loading", results: [] } });
    searchAddresses(rnQueries).then(
      (results) => onLookupsChange(row.key, { rn: { state: "done", results } }),
      () => onLookupsChange(row.key, { rn: { state: "error", results: [] } }),
    );
  };

  // The people list is asked for by clicking the header's occurrence count —
  // expanded rows are about picking a coordinate, and thirty person links per
  // row drowned the options they were there to support.
  const [peopleOpen, setPeopleOpen] = useState(false);

  // Inline rename of this row's raw place value (fix a typo so it matches).
  // The optional address draft splits the value into PLAC + ADDR on apply.
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameAddrDraft, setRenameAddrDraft] = useState("");
  // A register offer picked in the input: its place text is in the draft, and
  // its coordinate rides along on apply. Kept with the text it belongs to, so
  // editing the draft afterwards drops the coordinate instead of writing one
  // that describes a different place.
  const [renamePick, setRenamePick] = useState<{ place: string; addr?: string; assignment: GeoAssignment } | null>(null);
  const pickedCoord =
    renamePick && renamePick.place === renameDraft.trim() && (renamePick.addr ?? "") === renameAddrDraft.trim()
      ? renamePick.assignment
      : undefined;
  // Rename every occurrence of exactly this raw value, then rescan —
  // the corrected spelling gets fresh gazetteer proposals (or merges
  // into an already-covered row and drops off the list).
  const applyRename = () => {
    const target = renameDraft.trim();
    const addrTarget = renameAddrDraft.trim();
    if (!target || (target === row.key && !addrTarget)) return;
    onRename(row.key, target, addrTarget || undefined, pickedCoord);
    setRenameOpen(false);
    setRenamePick(null);
  };
  const renameDisabled = !renameDraft.trim() || (renameDraft.trim() === row.key && !renameAddrDraft.trim());

  // The address field's combos: pairs at *other* places, since the addresses of
  // the drafted place are already its plain suggestions.
  const addrCombos = useMemo(
    () => placeCombos.filter((cb) => placeKey(cb.place) !== placeKey(renameDraft)),
    [placeCombos, renameDraft],
  );

  /**
   * A register offer picked in the **address** field, where the register is
   * asked *where* a house stands rather than what to call it. The wording the
   * row already holds is the user's own — "Olševek 1 / 2 (pd Pilar)" names two
   * houses and the farm on them, which no register line will ever say — so text
   * is filled only where the field is empty, or replaced where the two differ
   * by nothing but spelling (the register's diacritics are worth having). The
   * coordinate always comes along: it is what the offer was picked for.
   */
  const pickAddrProposal = (proposal: PlaceProposal) => {
    const adopt = (own: string, offered: string | undefined) =>
      !own.trim() || (offered && placeCollator.compare(own.trim(), offered) === 0) ? offered : undefined;
    const place = adopt(renameDraft, proposal.plac) ?? renameDraft;
    const addr = adopt(renameAddrDraft, proposal.addr) ?? renameAddrDraft;
    setRenameDraft(place);
    setRenameAddrDraft(addr);
    setRenamePick({
      place: place.trim(),
      ...(addr.trim() ? { addr: addr.trim() } : {}),
      assignment: proposal.govId ? { coord: proposal.coord, govId: proposal.govId } : { coord: proposal.coord },
    });
  };

  const pickCandidate = (cand: GazCandidate) =>
    onPickCoord(row, { lat: cand.entry.lat, lon: cand.entry.lon }, pickLabel(cand.entry.name, cand.adminDisplay ?? cand.entry.admin));

  /**
   * Every position the option list offers, in the order it shows them — with
   * the words that name it and the pick it stands for. The index is the number
   * printed beside each option, the number its pin wears on the map, and the
   * number the coordinate panel repeats: a row four registers answered at four
   * points is read by matching numbers instead of guessing which dot is which
   * line.
   *
   * One entry per *coordinate*, so two registers that agree on a point share
   * one number: they are one place, and the map has one pin for them. The list
   * below still prints both lines, both under that number.
   */
  const options: {
    coord: GeoCoord;
    label: string;
    detail?: string;
    source?: string;
    badgeClass?: string;
    take: () => void;
  }[] = [];
  const addOption = (option: (typeof options)[number]) => {
    if (!options.some((o) => sameCoord(o.coord, option.coord))) options.push(option);
  };
  if (row.fileCoord)
    addOption({
      coord: row.fileCoord,
      label: t("tools.geocode.fromFile"),
      take: () => onPickCoord(row, row.fileCoord!, t("tools.geocode.fromFile")),
    });
  for (const cand of row.candidates) {
    const admin = adminOf(cand.entry.name, cand.adminDisplay ?? cand.entry.admin);
    addOption({
      coord: { lat: cand.entry.lat, lon: cand.entry.lon },
      label: cand.entry.name,
      ...(admin ? { detail: admin } : {}),
      source: `${Math.round(cand.score * 100)}%`,
      badgeClass: "reuse",
      take: () => pickCandidate(cand),
    });
  }
  for (const r of online.results)
    addOption({
      coord: r.coord,
      label: pickLabel(r.name, r.admin),
      ...(osmKindLabel(r, t) ? { detail: osmKindLabel(r, t)! } : {}),
      source: "OSM",
      badgeClass: "reuse",
      take: () => onPickCoord(row, r.coord, pickLabel(r.name, r.admin)),
    });
  for (const r of gov.results)
    addOption({
      coord: r.coord,
      label: pickLabel(r.name, r.admin),
      source: "GOV",
      badgeClass: "official",
      take: () => onPickCoord(row, r.coord, pickLabel(r.name, r.admin), r.govId),
    });
  for (const r of rn.results)
    addOption({
      coord: r.coord,
      label: r.label,
      source: "GURS",
      badgeClass: "official",
      take: () => onPickCoord(row, r.coord, r.address),
    });
  const numberOf = (coord: GeoCoord): number | undefined => {
    const i = options.findIndex((o) => sameCoord(o.coord, coord));
    return i === -1 ? undefined : i + 1;
  };

  /**
   * A position taken in the coordinate panel: one of the row's own answers,
   * which is picked exactly as its line would have picked it — a GOV answer
   * carries the identity that writes `_GOV`, which a bare coordinate cannot —
   * or, when the panel found or was typed something the list does not hold, a
   * pick of the row's own.
   */
  const takeFromPanel = (coord: GeoCoord, label?: string) => {
    const hit = options.find((o) => sameCoord(o.coord, coord));
    if (hit) hit.take();
    else onPickCoord(row, coord, label ?? t("tools.geocode.manual"));
  };

  // The online searches: beside "Show on map" while the map is closed, and
  // under the map once it is open — either way one action row, not a stray
  // entry at the bottom of the candidate list.
  // A search that has answered takes its button away: the answer is the option
  // list below, and asking the same register the same question again returns
  // it. An error keeps the button, since retrying is the whole recourse — and
  // renaming the place makes a new row, whose searches start unasked.
  // The register lookup is offered on its own terms: a Croatian address is
  // answered out of this browser, so the online-lookups opt-in — which is about
  // what leaves the device — has nothing to say about it. The searches below it
  // all go over the wire and stay behind the opt-in.
  // Subscribed, not read: what matters is that this row re-renders when a
  // register is stored or dropped, so the button stops hiding behind an opt-in
  // that no longer applies to it.
  useLocalRegisters();
  const registerLocal = isOfflineQuery(rnQueries);
  const registerActions = (appSettings.allowLinkFetch || registerLocal) && rnQueries.length > 0 && (
    // Only for a value that names a house number — the register resolves
    // houses, not settlements.
    <LookupAction
      kind="rn"
      state={rn}
      onRun={runRnSearch}
      title={t(registerLocal ? "tools.geocode.rn.tooltipLocal" : "tools.geocode.rn.tooltip")}
    />
  );

  const searchActions = (
    <>
      {registerActions}
      {appSettings.allowLinkFetch && (
        <>
          <LookupAction kind="online" state={online} onRun={runOnlineSearch} title={t("tools.geocode.online.tooltip")} />
          <LookupAction kind="gov" state={gov} onRun={runGovSearch} title={t("tools.geocode.gov.tooltip")} />
        </>
      )}
    </>
  );

  return (
    <li className="tools-tree-node">
      <GeoRowHeader
        open={isOpen}
        onToggle={() => onToggleOpen(row.key)}
        place={<span className={marked ? "tools-reshape-removed" : undefined}>{row.key}</span>}
      >
        {renameOpen ? (
          <button
            className="tools-place-edit-btn tools-place-edit-cancel"
            onClick={() => setRenameOpen(false)}
            title={t("tools.places.rename.cancel")}
          >
            ✕
          </button>
        ) : (
          <button
            className="tools-place-edit-btn"
            onClick={() => {
              setRenameOpen(true);
              setRenameDraft(row.key);
              setRenameAddrDraft("");
            }}
            title={t("tools.geocode.renameOpen")}
          >
            {/* ✎ (U+270E), the same edit mark the places tree and Organize
                sources use — not the horizontal ✏ variant. */}
            ✎
          </button>
        )}
        {/* The people the value belongs to — which is what clicking it shows.
            Beside the name and its ✎, where the places tree has always kept it
            and where every list on these pages now does: the count is part of
            what the row *is*, not one of the actions pinned to its end. */}
        <button
          className="tools-chip-count tools-count-toggle"
          title={missingInTitle}
          aria-pressed={peopleOpen}
          aria-label={t("tools.geocode.peopleToggle")}
          onClick={() => {
            const next = !peopleOpen;
            setPeopleOpen(next);
            if (next && !isOpen) onToggleOpen(row.key);
          }}
        >
          {row.missingIn.length}
        </button>
        {c && (
          // The position this row is about to take, and the way to look at it:
          // one click opens the row and puts its map on screen (the places tree
          // reads its coordinate the same way), another puts the map away.
          <button
            type="button"
            className={`tools-tree-meta tools-geo-coord-btn${override ? " staged" : ""}`}
            // Where the coordinate comes from, said in words. The line used to
            // open with an arrow, which in the compliance lists means "becomes"
            // — so beside the register's shorter name it read as an offer to
            // rename the place and drop everything the value says past its
            // settlement ("Šmartno pri Litiji, sv. Martin" → "Šmartno pri
            // Litiji"). Nothing of the kind happens here: only a coordinate is
            // written, and the value keeps every word of it. Hence "=" — this
            // place *is* that register entry — and renaming stays the "Use
            // official name" button, which says so.
            title={`${t("tools.geocode.coordHint", { label: c.label })}\n${
              override ? t("tools.geocode.stagedHint") : t("tools.geocode.showMap")
            }`}
            onClick={() => {
              // The coordinate opens the panel that decides it — and the row
              // with it, so the answers the panel numbers are also readable as
              // the list they came from.
              if (!isOpen) onToggleOpen(row.key);
              onToggleMap(row.key);
            }}
          >
            = {c.label} · <span className="gm-data gm-coord gm-coord--set">{formatCoord(c.coord)}</span>
          </button>
        )}
        {/* The coordinate panel itself, with no button of its own: the
            coordinate above opens it, and so does the map link among the row's
            actions. The same panel the addresses list and the Edit rows open —
            its map carries this row's numbered answers, and the house or hamlet
            no gazetteer holds is typed or picked off the map in here. A pick is
            staged like the radios below; nothing is written until Write. */}
        <EventCoordPicker
          place={row.key}
          address=""
          coord={override?.coord}
          title={row.key}
          hideTrigger
          open={hasMap}
          onOpenChange={(next) => next !== hasMap && onToggleMap(row.key)}
          // The row's own answers, under the numbers the list below prints —
          // the file's coordinate first, then the gazetteer, then whatever the
          // searches brought in. The panel draws no second copy of them.
          {...(options.length ? { candidates: options } : {})}
          // Every coordinate the file carries, as faint dots: the family
          // cluster is what tells two same-named villages apart.
          context={fileCoords}
          // Village scale, not the default house zoom: answers for one name
          // often sit a few hundred metres apart (the place, the street named
          // after it), and at house zoom the map opens inside one of them.
          fitMaxZoom={14}
          // A search run in the panel is this row's search: its answers land in
          // the list below under the row's own numbers, and the row's button
          // for it goes — asking the same service the same question again
          // returns what is already on screen.
          onRegisterSearch={(next) => onLookupsChange(row.key, { rn: next })}
          onOnlineSearch={(next) => onLookupsChange(row.key, { online: next })}
          onPick={takeFromPanel}
          onClear={() => onUnpickCoord(row)}
        />
        {marked ? (
          <span className="tools-reshape-badge remove" title={t("tools.geocode.noMatch")}>
            {t("tools.geocode.noMatchBadge")}
          </span>
        ) : row.placed && !override ? (
          <span className="tools-reshape-badge new" title={t("tools.geocode.placedTooltip")}>
            {t("tools.geocode.placedBadge")}
          </span>
        ) : row.fileCoord && !override ? (
          <span className="tools-reshape-badge new" title={t("tools.geocode.fromFileTooltip")}>
            {t("tools.geocode.fromFile")}
          </span>
        ) : row.candidates[0] && !override ? (
          // Green when confident — or hand-selected for writing: a
          // checked row's badge should read as "going in" too.
          <span className={scoreBadgeClass(row.candidates[0].score, !!override)}>
            {Math.round(row.candidates[0].score * 100)}%
          </span>
        ) : !c ? (
          <span className="tools-tree-meta">{t("tools.geocode.noCandidate")}</span>
        ) : null}
        {officialTo && officialCand && !marked && (
          <button
            className="tools-issue-link"
            title={t("tools.geocode.official.tooltip", { name: officialCand.entry.name })}
            onClick={() =>
              onRename(row.key, officialTo, undefined, {
                coord: { lat: officialCand.entry.lat, lon: officialCand.entry.lon },
              })
            }
          >
            {t("tools.geocode.official.take")}
          </button>
        )}
        {/* "No match" is a verdict on an unanswered question — a placed row's
            question is answered, so the mark is not offered there. */}
        {!row.placed && (
          <button
            className="tools-issue-link"
            onClick={() => onToggleNoMatch(row.key)}
            aria-pressed={marked}
            title={marked ? t("tools.geocode.noMatchUndo") : t("tools.geocode.noMatch")}
          >
            {marked ? t("tools.geocode.restore") : t("tools.geocode.hide")}
          </button>
        )}
      </GeoRowHeader>
      {renameOpen && (
        // The rename box every list of these tools opens — its completions, its
        // register lookup and its Enter/Escape contract. What is particular to
        // this row is the address field beside the place, which splits the value
        // as it renames it.
        <RenameEditor
          value={renameDraft}
          suggestions={placeSug.placeSuggestions}
          canonical={placeSug.placeCanonical}
          combos={placeCombos}
          placeholder={t("tools.places.rename.placeholder")}
          applyDisabled={renameDisabled}
          onChange={setRenameDraft}
          onApply={applyRename}
          onCancel={() => setRenameOpen(false)}
          onPickCombo={(place, addr) => {
            setRenameDraft(place);
            setRenameAddrDraft(addr);
            setRenamePick(null);
          }}
          // A place this file has never written — the very case a geocode row
          // is about — is completed from the registers, with its chain, its
          // house address and the coordinate that resolves the row.
          onPickProposal={(proposal) => {
            setRenameDraft(proposal.plac);
            setRenameAddrDraft(proposal.addr ?? "");
            setRenamePick({
              place: proposal.plac,
              ...(proposal.addr ? { addr: proposal.addr } : {}),
              assignment: proposal.govId ? { coord: proposal.coord, govId: proposal.govId } : { coord: proposal.coord },
            });
          }}
          // Online lookups off still leaves the imported gazetteer answering,
          // so the search stays offered and the row says what it can't reach.
          onLookup={lookup ? (query) => lookup.search(query) : undefined}
          lookupNote={lookup && !lookup.online ? t("event.place.lookup.offlineOnly") : undefined}
        >
          {/* The address half of the split, with the same three helps the place
              beside it has: what this file already writes at that place, the
              place·address pairs it knows, and the address register itself.
              The register matters most here — a house number is exactly what
              the settlements gazetteer cannot answer, and a value naming a
              quarter of a town ("Čirče") is filed there as a street inside the
              town, reachable only by asking for the address. */}
          <span className="tools-geo-addr-chip tools-geo-addr-chip--field" title={t("tools.geocode.renameAddrTooltip")}>
            {t("event.colAddr")}:
            <PlaceAutocomplete
              value={renameAddrDraft}
              suggestions={placeSug.placeToAddrs.get(placeKey(renameDraft)) ?? []}
              canonical={placeSug.addrCanonical}
              combos={addrCombos}
              // The pair list is this field's only route to another settlement,
              // so a typed place name matches too (as in the Edit row).
              matchCombosByPlace
              isDirty={false}
              className="tools-geo-addr-chip-input"
              wrapClassName="tools-geo-addr-chip-auto"
              placeholder={t("tools.geocode.renameAddrPlaceholder")}
              onChange={setRenameAddrDraft}
              onCommit={setRenameAddrDraft}
              onClear={() => setRenameAddrDraft("")}
              onPickCombo={(place, addr) => {
                setRenameDraft(place);
                setRenameAddrDraft(addr);
                setRenamePick(null);
              }}
              onPickProposal={pickAddrProposal}
              // House numbers live only in the online registers — an imported
              // gazetteer holds settlements — so with the opt-in off the field
              // says why instead of offering a search that cannot answer.
              onLookup={lookup?.online ? (query) => lookup.searchAddress(renameDraft, query) : undefined}
              lookupNote={lookup && !lookup.online ? t("tools.geocode.downloadNeedsOptIn") : undefined}
            />
          </span>
        </RenameEditor>
      )}
      {isOpen && (
        <div className="tools-tree-children tools-geo-detail">
          {/* The row's actions stand in one place, above its answers, as in
              the addresses and compliance lists — and the map among them is now
              the coordinate panel's, opened from here or from the coordinate in
              the header. A row with no answers at all is exactly where the
              searches are needed, so they stand there either way. */}
          <div className="tools-geo-actions">
            <MapToggle open={hasMap} onToggle={() => onToggleMap(row.key)} />
            {searchActions}
          </div>
          <ul className="tools-geo-candidates">
            {/* The file's own coordinate as the first option — it is
                the default proposal, so it must show as selected. */}
            {/* Each option's number is also its radio, and the number its pin
                wears in the coordinate panel: a row answered by four registers
                at four points is read by matching numbers rather than by
                guessing which dot is which line. Two answers at the very same
                point share a number, which is the truth about them. */}
            {row.fileCoord && (
              <li>
                <label>
                  <input
                    type="radio"
                    className="tools-geo-cand-radio"
                    name={`geo-${row.key}`}
                    aria-label={t("tools.geocode.fromFile")}
                    checked={sameCoord(override?.coord, row.fileCoord)}
                    onClick={() => sameCoord(override?.coord, row.fileCoord) && onUnpickCoord(row)}
                    onChange={() => onPickCoord(row, row.fileCoord!, t("tools.geocode.fromFile"))}
                  />
                  <span className="tools-geo-cand-num">{numberOf(row.fileCoord)}</span>
                  <span className="tools-geo-cand-name">{t("tools.geocode.fromFile")}</span>
                  <span className="gm-data gm-coord">
                    {formatCoord(row.fileCoord)}
                  </span>
                </label>
              </li>
            )}
            {row.candidates.map((cand, i) => (
              <li key={i}>
                <label>
                  <input
                    type="radio"
                    className="tools-geo-cand-radio"
                    name={`geo-${row.key}`}
                    aria-label={cand.entry.name}
                    checked={sameCoord(override?.coord, { lat: cand.entry.lat, lon: cand.entry.lon })}
                    onClick={() => sameCoord(override?.coord, { lat: cand.entry.lat, lon: cand.entry.lon }) && onUnpickCoord(row)}
                    onChange={() => pickCandidate(cand)}
                  />
                  <span className="tools-geo-cand-num">{numberOf({ lat: cand.entry.lat, lon: cand.entry.lon })}</span>
                  <span className="tools-geo-cand-name">{cand.entry.name}</span>
                  {/* The division the register files it under — the only thing
                      that tells two same-named settlements apart. In the file's
                      own spelling when the place string names the division. */}
                  {adminOf(cand.entry.name, cand.adminDisplay ?? cand.entry.admin) && (
                    <span className="tools-geo-count" title={t("tools.geocode.adminHint")}>
                      ({adminOf(cand.entry.name, cand.adminDisplay ?? cand.entry.admin)})
                    </span>
                  )}
                  <span className="gm-data gm-coord">
                    {cand.entry.population > 0 && `· ${t("tools.geocode.population", { count: cand.entry.population })} · `}
                    {formatCoord({ lat: cand.entry.lat, lon: cand.entry.lon })}
                  </span>
                  {/* Green means "this is going in", the same as in the row's
                      header — so the candidate the row is actually on wears the
                      header's colour, and the rest are judged on their score
                      alone. Passing `false` here made a header's green 99% read
                      amber, and its green 100% read neutral, one line apart. */}
                  <span
                    className={scoreBadgeClass(
                      cand.score,
                      sameCoord(override?.coord, { lat: cand.entry.lat, lon: cand.entry.lon }),
                    )}
                  >
                    {Math.round(cand.score * 100)}%
                  </span>
                  {/* Source last, like the GOV/OSM/GURS rows below: the full
                      directory id — register code (SI-GURS), download key
                      (HR-OSM), or the bare country code, which by convention
                      means the GeoNames file. */}
                  <span className={`tools-reshape-badge ${cand.entry.register ? "official" : "reuse"}`}>
                    {cand.entry.register ?? cand.entry.source ?? cand.entry.country}
                  </span>
                </label>
              </li>
            ))}
            {online.results.map((r, i) => (
              <li key={`osm-${i}`}>
                <label title={r.label}>
                  <input
                    type="radio"
                    className="tools-geo-cand-radio"
                    name={`geo-${row.key}`}
                    aria-label={r.name}
                    checked={sameCoord(override?.coord, r.coord)}
                    onClick={() => sameCoord(override?.coord, r.coord) && onUnpickCoord(row)}
                    onChange={() => onPickCoord(row, r.coord, pickLabel(r.name, r.admin))}
                  />
                  <span className="tools-geo-cand-num">{numberOf(r.coord)}</span>
                  {/* Name and parent, like the register and GOV rows — the full
                      chain would run the row off the line, and is in the title. */}
                  <span className="tools-geo-cand-name">{r.name}</span>
                  {r.admin && <span className="tools-geo-count">({r.admin})</span>}
                  {/* What the hit is: OpenStreetMap answers one name with the
                      place, the street named after it and the service road off
                      that, all three spelled identically. */}
                  {osmKindLabel(r, t) && <span className="tools-geo-cand-kind">{osmKindLabel(r, t)}</span>}
                  <span className="gm-data gm-coord">
                    {formatCoord(r.coord)}
                  </span>
                  <span className="tools-reshape-badge reuse">OSM</span>
                </label>
              </li>
            ))}
            {gov.results.map((r, i) => (
              <li key={`gov-${i}`}>
                <label title={`${r.label} · GOV ${r.govId}`}>
                  <input
                    type="radio"
                    className="tools-geo-cand-radio"
                    name={`geo-${row.key}`}
                    aria-label={r.label}
                    checked={sameCoord(override?.coord, r.coord)}
                    onClick={() => sameCoord(override?.coord, r.coord) && onUnpickCoord(row)}
                    onChange={() => onPickCoord(row, r.coord, pickLabel(r.name, r.admin), r.govId)}
                  />
                  <span className="tools-geo-cand-num">{numberOf(r.coord)}</span>
                  <span className="tools-geo-cand-name">{r.label}</span>
                  {/* The place it is part of, like the register candidates —
                      four same-named Osredek differ only in this. */}
                  {r.admin && <span className="tools-geo-count">({r.admin})</span>}
                  <span className="gm-data gm-coord">
                    {formatCoord(r.coord)}
                  </span>
                  <span className="tools-reshape-badge new">GOV</span>
                </label>
              </li>
            ))}
            {rn.results.map((r, i) => (
              <li key={`rn-${i}`}>
                <label title={r.label}>
                  <input
                    type="radio"
                    className="tools-geo-cand-radio"
                    name={`geo-${row.key}`}
                    aria-label={r.address}
                    checked={sameCoord(override?.coord, r.coord)}
                    onClick={() => sameCoord(override?.coord, r.coord) && onUnpickCoord(row)}
                    onChange={() => onPickCoord(row, r.coord, r.address)}
                  />
                  <span className="tools-geo-cand-num">{numberOf(r.coord)}</span>
                  {/* A register hit is a house, not a place — pinned, so it is
                      not read as another spelling of the settlement above. */}
                  <span className="tools-geo-cand-name gm-addr">{r.label}</span>
                  <span className="gm-data gm-coord">
                    {formatCoord(r.coord)}
                  </span>
                  <span className="tools-reshape-badge official">GURS</span>
                </label>
              </li>
            ))}
          </ul>
          {/* Who this unresolved place belongs to — shown only when the
              header's count was clicked for it. */}
          {peopleOpen && (
            <GeoPeopleList
              dataset={dataset}
              ids={row.missingIn}
              place={row.key}
              kinship={kinship}
              onNavigate={onNavigate}
            />
          )}
        </div>
      )}
    </li>
  );
}
