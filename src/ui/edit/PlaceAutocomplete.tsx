import React, { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ClearableInput } from "./ClearableInput";
import { applyCanonical, BY_HOUSE_NUMBER } from "./placeSuggestions";
import { proposalKey, type PlaceProposal } from "../../geo/placeProposal";
import { placeCompareKey } from "../../match/place";

/** One dropdown entry: a plain place, a place+address combo (shown as
 *  "place · address", filling both fields when picked), or a register's offer
 *  for a place the file does not have yet. */
interface Item {
  place: string;
  addr?: string;
  proposal?: PlaceProposal;
  /** A place offered on its own from a field that is not the place field (the
   *  address field, which reaches other settlements through the pair list):
   *  picking it sets the place and clears the address, rather than writing the
   *  place's name into the field the user is typing in. */
  movesPlace?: boolean;
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
  matchCombosByPlace,
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
  offerKnown,
}: {
  value: string;
  suggestions: string[];
  canonical: Map<string, string>;
  /** Known place+address pairs, offered when the query matches the address. */
  combos?: { place: string; addr: string }[];
  /** Also offer a combo when the query matches its *place* text. For the
   *  address field, where the pair list is the only route to another
   *  settlement: "Breg ob K…" must reach Breg ob Kokri's houses even though
   *  no address text contains it. The place field keeps this off — there a
   *  plain place query should list places, not every known address at them. */
  matchCombosByPlace?: boolean;
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
  /** Offer the registers even for a place the file already writes, and keep an
   *  offer that only repeats one. Both are hidden by default because the file's
   *  own list already has the text — but where the lookup is wanted for what
   *  rides *with* the text (the register's coordinate, its municipality), the
   *  text being familiar is no reason to withhold the answer. */
  offerKnown?: boolean;
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
    (offerKnown || !known.has(placeCompareKey(value)));

  const filtered = useMemo((): Item[] => {
    const q = value.trim().toLowerCase();
    if (!q) return [];
    // A match at the start of the text reads as "the one you meant" more than
    // a hit buried inside a longer name ("Sv. Peter" before "Pokopališče ob
    // cerkvi sv. Martin"), so starts-with matches lead, list order otherwise.
    const byPrefix = <T,>(items: T[], text: (item: T) => string): T[] => [
      ...items.filter((item) => text(item).toLowerCase().startsWith(q)),
      ...items.filter((item) => !text(item).toLowerCase().startsWith(q)),
    ];
    const plain: Item[] = byPrefix(
      suggestions.filter((s) => s.toLowerCase().includes(q)),
      (s) => s,
    ).map((s) => ({ place: s }));
    // Combos when the query matches the address text (or, where the host
    // opted in, the place text — see matchCombosByPlace).
    const comboHits = onPickCombo
      ? byPrefix(
          (combos ?? []).filter(
            (cb) =>
              cb.addr.toLowerCase().includes(q) ||
              (matchCombosByPlace && cb.place.toLowerCase().includes(q)),
          ),
          (cb) => cb.addr,
        )
      : [];
    // Naming a place here means the place itself, so offer it plainly before
    // any of its houses: picking it moves the event and takes the place's own
    // coordinate, leaving the address empty. Only for combos matched on their
    // place text — someone typing a house number means the house.
    const barePlaces: Item[] = [];
    if (matchCombosByPlace && onPickCombo) {
      const seen = new Set(plain.map((item) => placeCompareKey(item.place)));
      for (const cb of byPrefix(
        comboHits.filter((cb) => cb.place.toLowerCase().includes(q)),
        (cb) => cb.place,
      )) {
        const key = placeCompareKey(cb.place);
        if (seen.has(key)) continue;
        seen.add(key);
        barePlaces.push({ place: cb.place, movesPlace: true });
      }
      barePlaces.sort(
        (a, b) =>
          Number(b.place.toLowerCase().startsWith(q)) - Number(a.place.toLowerCase().startsWith(q)) ||
          a.place.localeCompare(b.place),
      );
    }
    // Round-robin across places: the pair list is grouped per place, so one
    // place with many matching houses (Breg ob Savi's "Breg 2…22") would
    // otherwise crowd every other matching place (Breg ob Kokri's) out of the
    // capped list below.
    const byPlace = new Map<string, { place: string; addr: string }[]>();
    for (const cb of comboHits) {
      const bucket = byPlace.get(cb.place);
      if (bucket) bucket.push(cb);
      else byPlace.set(cb.place, [cb]);
    }
    const buckets = [...byPlace.values()];
    const picked: { place: string; addr: string }[] = [];
    const rounds = buckets.length ? Math.max(...buckets.map((b) => b.length)) : 0;
    for (let i = 0; i < rounds; i++) {
      for (const b of buckets) {
        if (i < b.length) picked.push(b[i]);
      }
    }
    // Shown grouped, though: a place's houses stand together and in house-number
    // order ("Breg 2" before "Breg 11"), and the places named by what was typed
    // — or holding a house named by it — lead. Round-robin decides *which* pairs
    // fit the cap; it is no order to read a list in.
    const shownOrder = (pairs: { place: string; addr: string }[]): Item[] => {
      const groups = new Map<string, { place: string; addr: string }[]>();
      for (const cb of pairs) {
        const bucket = groups.get(cb.place);
        if (bucket) bucket.push(cb);
        else groups.set(cb.place, [cb]);
      }
      return [...groups.values()]
        .map((items) => ({
          items: [...items].sort((a, b) => BY_HOUSE_NUMBER.compare(a.addr, b.addr)),
          lead:
            items[0].place.toLowerCase().startsWith(q) ||
            items.some((cb) => cb.addr.toLowerCase().startsWith(q))
              ? 0
              : 1,
        }))
        .sort((a, b) => a.lead - b.lead || a.items[0].place.localeCompare(b.items[0].place))
        .flatMap((g) => g.items.map((cb) => ({ place: cb.place, addr: cb.addr })));
    };
    // The address field puts its own place's addresses (the plain list) first,
    // in full: they are the answers "from here", and pairs at other places only
    // fill what room is left. The place field instead reserves room for combo
    // hits — with 8+ matching places the address pairs would otherwise never
    // surface at all.
    const comboRoom = matchCombosByPlace ? 0 : Math.min(picked.length, 3);
    const plainPart = plain.slice(0, 8 - comboRoom);
    const room = Math.max(0, 8 - barePlaces.length - plainPart.length);
    const fromFile = [...barePlaces, ...plainPart, ...shownOrder(picked.slice(0, room))];
    // Register offers sit below the file's own places: what the file already
    // uses is the better answer whenever it fits, and only the rest needs a
    // register. They are shown for the query they were fetched for, so an
    // edited query doesn't leave the previous place's answers standing.
    const offers: Item[] =
      search.query === value.trim()
        ? search.results
            .filter((p) => offerKnown || p.addr || !known.has(placeCompareKey(p.plac)))
            .map((p) => ({ place: p.plac, addr: p.addr, proposal: p }))
        : [];
    return [...fromFile, ...offers];
  }, [value, suggestions, combos, matchCombosByPlace, onPickCombo, search, known, offerKnown]);

  const showDropdown = open && (filtered.length > 0 || canSearch);

  function selectSuggestion(item: Item) {
    // A register offer carries its own place, address and coordinate; a combo
    // pick is handled entirely by onPickCombo (it sets both fields — this
    // component may be hosted by either of them); a plain place goes through
    // the usual change+commit pair.
    if (item.proposal && onPickProposal) {
      onPickProposal(item.proposal);
    } else if ((item.addr || item.movesPlace) && onPickCombo) {
      // "" for a bare place: the pair pick writes both fields, so the address
      // this field holds is cleared as the event moves.
      onPickCombo(item.place, item.addr ?? "");
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
