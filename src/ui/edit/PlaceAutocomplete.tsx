import React, { useMemo, useRef, useState } from "react";
import { ClearableInput } from "./ClearableInput";
import { applyCanonical } from "./placeSuggestions";

/** A text input with dropdown autocomplete from a pre-built suggestion list.
 * When the user selects a suggestion or blurs, the canonical form is applied. */
export function PlaceAutocomplete({
  value,
  suggestions,
  canonical,
  isDirty,
  isMerge,
  className,
  wrapClassName,
  wrapStyle,
  placeholder,
  title,
  onChange,
  onCommit,
  onClear,
}: {
  value: string;
  suggestions: string[];
  canonical: Map<string, string>;
  isDirty: boolean;
  isMerge?: boolean;
  className?: string;
  wrapClassName?: string;
  wrapStyle?: React.CSSProperties;
  placeholder?: string;
  title?: string;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return [];
    return suggestions.filter((s) => s.toLowerCase().includes(q)).slice(0, 8);
  }, [value, suggestions]);

  const showDropdown = open && filtered.length > 0;

  function selectSuggestion(suggestion: string) {
    onChange(suggestion);
    onCommit(suggestion);
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
              key={s}
              role="option"
              aria-selected={i === highlighted}
              className={i === highlighted ? "place-suggestion place-suggestion--hi" : "place-suggestion"}
              onMouseDown={(e) => { e.preventDefault(); selectSuggestion(s); }}
            >
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
