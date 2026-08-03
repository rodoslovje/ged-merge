import React, { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ClearableInput } from "./ClearableInput";
import { applyCanonical } from "./placeSuggestions";
import { proposalKey, type PlaceProposal } from "../../geo/placeProposal";
import { placeCompareKey } from "../../match/place";

/** One dropdown entry: a plain place, a place+address combo (shown as
 *  "place · address", filling both fields when picked), or a register's offer
 *  for a place the file does not have yet. */
interface Item {
  place: string;
  addr?: string;
  proposal?: PlaceProposal;
}

type SearchState = { state: "idle" | "loading" | "error" | "done"; query: string; results: PlaceProposal[] };

const IDLE: SearchState = { state: "idle", query: "", results: [] };

/** A text input with dropdown autocomplete from a pre-built suggestion list.
 * When the user selects a suggestion or blurs, the canonical form is applied.
 * With `combos`, known place+address pairs are offered too — matched by their
 * address text — and picking one reports the pair through `onPickCombo`.
 * With `onPickProposal`, a place the file has never used can be looked up in
 * the gazetteer and the online registers, which supply its full jurisdiction
 * chain, its house address and its coordinate. */
export function PlaceAutocomplete({
  value,
  suggestions,
  canonical,
  combos,
  isDirty,
  isMerge,
  className,
  wrapClassName,
  wrapStyle,
  placeholder,
  title,
  autoFocus,
  preserveCase,
  onChange,
  onCommit,
  onClear,
  onPickCombo,
  onPickProposal,
  onLookup,
  lookupNote,
}: {
  value: string;
  suggestions: string[];
  canonical: Map<string, string>;
  /** Known place+address pairs, offered when the query matches the address. */
  combos?: { place: string; addr: string }[];
  isDirty: boolean;
  isMerge?: boolean;
  className?: string;
  wrapClassName?: string;
  wrapStyle?: React.CSSProperties;
  placeholder?: string;
  title?: string;
  autoFocus?: boolean;
  /** Commit the text exactly as typed — no canonical-casing snap on blur.
   *  For rename fields, whose very purpose may be a casing fix the canonical
   *  map would otherwise undo (picking a suggestion still applies it). */
  preserveCase?: boolean;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
  onClear: () => void;
  onPickCombo?: (place: string, addr: string) => void;
  /** Called with the register offer the user picked. Required, with `onLookup`
   *  or `lookupNote`, for the lookup row to appear at all. */
  onPickProposal?: (proposal: PlaceProposal) => void;
  /** Runs the register search for the typed text. The host supplies it, since
   *  what "look this up" means differs per field: a place is searched on its
   *  own, an address within the event's place. */
  onLookup?: (query: string) => Promise<PlaceProposal[]>;
  /** Why the lookup can do less than usual (e.g. online lookups are off).
   *  Shown in the lookup row; on its own it makes the row appear with no
   *  button, which is how a field says the search is unavailable and why. */
  lookupNote?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const [search, setSearch] = useState<SearchState>(IDLE);
  const containerRef = useRef<HTMLDivElement>(null);

  /** Places the file already writes, so a register offer that only repeats one
   *  is left out — it is in the list above already, canonically spelled. An
   *  offer that adds an address still earns its row: it carries the house. */
  const known = useMemo(() => new Set(suggestions.map(placeCompareKey)), [suggestions]);

  /** The lookup is offered for a value the file cannot answer itself: once the
   *  text names one the file already writes, the row would only be in the way
   *  of the ordinary editing it interrupts. */
  const canSearch =
    !!onPickProposal &&
    (!!onLookup || !!lookupNote) &&
    value.trim().length >= 2 &&
    !known.has(placeCompareKey(value));

  const filtered = useMemo((): Item[] => {
    const q = value.trim().toLowerCase();
    if (!q) return [];
    const plain: Item[] = suggestions.filter((s) => s.toLowerCase().includes(q)).map((s) => ({ place: s }));
    // Combos only when the query matches the address text — a plain place
    // query should list places, not every known address at them.
    const withAddr: Item[] = onPickCombo
      ? (combos ?? []).filter((cb) => cb.addr.toLowerCase().includes(q)).map((cb) => ({ place: cb.place, addr: cb.addr }))
      : [];
    // Reserve room for combo hits: with 8+ plain matches the address lookup
    // would otherwise never surface at all.
    const comboRoom = Math.min(withAddr.length, 3);
    const fromFile = [...plain.slice(0, 8 - comboRoom), ...withAddr].slice(0, 8);
    // Register offers sit below the file's own places: what the file already
    // uses is the better answer whenever it fits, and only the rest needs a
    // register. They are shown for the query they were fetched for, so an
    // edited query doesn't leave the previous place's answers standing.
    const offers: Item[] =
      search.query === value.trim()
        ? search.results
            .filter((p) => p.addr || !known.has(placeCompareKey(p.plac)))
            .map((p) => ({ place: p.plac, addr: p.addr, proposal: p }))
        : [];
    return [...fromFile, ...offers];
  }, [value, suggestions, combos, onPickCombo, search, known]);

  const showDropdown = open && (filtered.length > 0 || canSearch);

  function selectSuggestion(item: Item) {
    // A register offer carries its own place, address and coordinate; a combo
    // pick is handled entirely by onPickCombo (it sets both fields — this
    // component may be hosted by either of them); a plain place goes through
    // the usual change+commit pair.
    if (item.proposal && onPickProposal) {
      onPickProposal(item.proposal);
    } else if (item.addr && onPickCombo) {
      onPickCombo(item.place, item.addr);
    } else {
      onChange(item.place);
      onCommit(item.place);
    }
    setOpen(false);
    setHighlighted(-1);
    setSearch(IDLE);
  }

  function runSearch() {
    const query = value.trim();
    if (!onLookup || query.length < 2) return;
    setSearch({ state: "loading", query, results: [] });
    onLookup(query).then(
      (results) => setSearch({ state: "done", query, results }),
      () => setSearch({ state: "error", query, results: [] }),
    );
  }

  function handleBlur(e: React.FocusEvent) {
    if (containerRef.current?.contains(e.relatedTarget as Node)) return;
    setOpen(false);
    setHighlighted(-1);
    const norm = preserveCase ? value.trim() : applyCanonical(value, canonical);
    if (norm !== value) onChange(norm);
    onCommit(norm);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlighted((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" && highlighted >= 0 && showDropdown) {
      e.preventDefault();
      selectSuggestion(filtered[highlighted]);
    } else if (e.key === "Escape") {
      // With the dropdown open, Escape only dismisses it — preventDefault
      // tells hosting editors (e.g. the geocode rename row) to stay open,
      // mirroring how a consumed Enter is signalled.
      if (showDropdown) e.preventDefault();
      setOpen(false);
      setHighlighted(-1);
    }
  }

  /** Whether the lookup state on screen belongs to the text now in the field. */
  const searchedThis = search.query === value.trim();

  return (
    <div ref={containerRef} className={`place-autocomplete-wrap${wrapClassName ? ` ${wrapClassName}` : ""}`} style={wrapStyle} onBlur={handleBlur}>
      <ClearableInput
        className={`${isMerge ? "edit-input--merge " : isDirty ? "edit-input--dirty " : ""}${className ?? ""}`}
        value={value}
        placeholder={placeholder}
        title={title}
        autoFocus={autoFocus}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setHighlighted(-1); }}
        onFocus={() => { if (value.trim()) setOpen(true); }}
        onKeyDown={handleKeyDown}
        onBlur={() => {}}
        onClear={() => { onClear(); setOpen(false); setSearch(IDLE); }}
      />
      {showDropdown && (
        <ul className="place-suggestions" role="listbox">
          {filtered.map((s, i) => (
            <li
              key={s.proposal ? `reg-${proposalKey(s.proposal)}` : s.addr ? `${s.place}|${s.addr}` : s.place}
              role="option"
              aria-selected={i === highlighted}
              title={s.proposal?.detail}
              className={
                (i === highlighted ? "place-suggestion place-suggestion--hi" : "place-suggestion") +
                (s.proposal ? " place-suggestion--register" : "")
              }
              onMouseDown={(e) => { e.preventDefault(); selectSuggestion(s); }}
            >
              {s.place}
              {s.addr && <span className="place-suggestion-addr"> · {s.addr}</span>}
              {s.proposal && (
                <span className={`tools-reshape-badge ${s.proposal.official ? "official" : "reuse"}`}>
                  {s.proposal.source}
                </span>
              )}
            </li>
          ))}
          {/* The register lookup: for a place the file itself cannot complete,
              and on demand only — the online registers are opt-in and rate
              limited, so they are never queried per keystroke. */}
          {canSearch && (
            <li className="place-suggestion-foot">
              {onLookup && (
                <button
                  type="button"
                  className="tools-issue-link"
                  disabled={search.state === "loading"}
                  // mousedown, not click: a click blurs the input first, and the
                  // wrapper's blur handler would have closed the dropdown.
                  onMouseDown={(e) => { e.preventDefault(); runSearch(); }}
                >
                  {search.state === "loading" && searchedThis
                    ? t("event.place.lookup.searching")
                    : t("event.place.lookup.search")}
                </button>
              )}
              {searchedThis && search.state === "error" && (
                <span className="place-suggestion-note">{t("event.place.lookup.error")}</span>
              )}
              {searchedThis && search.state === "done" && !filtered.some((f) => f.proposal) && (
                <span className="place-suggestion-note">{t("event.place.lookup.none")}</span>
              )}
              {lookupNote && <span className="place-suggestion-note">{lookupNote}</span>}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
