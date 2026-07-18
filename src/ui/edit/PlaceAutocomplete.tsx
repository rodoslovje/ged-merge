import React, { useMemo, useRef, useState } from "react";
import { ClearableInput } from "./ClearableInput";
import { applyCanonical } from "./placeSuggestions";

/** One dropdown entry: a plain place, or a place+address combo (shown as
 *  "place · address", filling both fields when picked). */
interface Item {
  place: string;
  addr?: string;
}

/** A text input with dropdown autocomplete from a pre-built suggestion list.
 * When the user selects a suggestion or blurs, the canonical form is applied.
 * With `combos`, known place+address pairs are offered too — matched by their
 * address text — and picking one reports the pair through `onPickCombo`. */
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
  onChange,
  onCommit,
  onClear,
  onPickCombo,
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
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
  onClear: () => void;
  onPickCombo?: (place: string, addr: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo((): Item[] => {
    const q = value.trim().toLowerCase();
    if (!q) return [];
    const plain: Item[] = suggestions.filter((s) => s.toLowerCase().includes(q)).map((s) => ({ place: s }));
    // Combos only when the query matches the address text — a plain place
    // query should list places, not every known address at them.
    const withAddr: Item[] = onPickCombo
      ? (combos ?? []).filter((cb) => cb.addr.toLowerCase().includes(q)).map((cb) => ({ place: cb.place, addr: cb.addr }))
      : [];
    return [...plain, ...withAddr].slice(0, 8);
  }, [value, suggestions, combos, onPickCombo]);

  const showDropdown = open && filtered.length > 0;

  function selectSuggestion(item: Item) {
    // A combo pick is handled entirely by onPickCombo (it sets both fields —
    // this component may be hosted by either of them), a plain place by the
    // usual change+commit pair.
    if (item.addr && onPickCombo) {
      onPickCombo(item.place, item.addr);
    } else {
      onChange(item.place);
      onCommit(item.place);
    }
    setOpen(false);
    setHighlighted(-1);
  }

  function handleBlur(e: React.FocusEvent) {
    if (containerRef.current?.contains(e.relatedTarget as Node)) return;
    setOpen(false);
    setHighlighted(-1);
    const norm = applyCanonical(value, canonical);
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
      setOpen(false);
      setHighlighted(-1);
    }
  }

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
        onClear={() => { onClear(); setOpen(false); }}
      />
      {showDropdown && (
        <ul className="place-suggestions" role="listbox">
          {filtered.map((s, i) => (
            <li
              key={s.addr ? `${s.place}|${s.addr}` : s.place}
              role="option"
              aria-selected={i === highlighted}
              className={i === highlighted ? "place-suggestion place-suggestion--hi" : "place-suggestion"}
              onMouseDown={(e) => { e.preventDefault(); selectSuggestion(s); }}
            >
              {s.place}
              {s.addr && <span className="place-suggestion-addr"> · {s.addr}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
