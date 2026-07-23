import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Individual } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { lifespanLabel } from "../../match/relatives";
import { foldSearch } from "../globalSearch";

/** Inline picker that lets the user either search for an existing person or add a new one. */
export function RelativePickerCard({
  roleLabel,
  individuals,
  excludeId,
  onPickExisting,
  onAddNew,
  onCancel,
  t,
}: {
  roleLabel?: string;
  individuals: Map<string, Individual>;
  excludeId: string;
  onPickExisting: (id: string) => void;
  onAddNew: () => void;
  onCancel: () => void;
  t: Translate;
}) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) onCancel();
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [onCancel]);

  const options = useMemo(() => {
    const q = foldSearch(query.trim());
    return [...individuals.values()]
      .filter((i) => i.id !== excludeId)
      .map((i) => ({ id: i.id, text: lifespanLabel(i) }))
      .sort((a, b) => a.text.localeCompare(b.text))
      .filter((o) => !q || foldSearch(o.text).includes(q))
      .slice(0, 10);
  }, [individuals, excludeId, query]);

  useEffect(() => { setActiveIdx(0); }, [query]);

  const totalItems = options.length + 1; // options + "Add new"

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { onCancel(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, totalItems - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
    if (e.key === "Enter") {
      e.preventDefault();
      if (activeIdx === 0) onAddNew();
      else onPickExisting(options[activeIdx - 1].id);
    }
  }

  return (
    <div className="person-card-wrap" ref={containerRef}>
      {roleLabel && <div className="person-card-role">{roleLabel}</div>}
      <div className="relative-picker">
        <input
          ref={inputRef}
          className="relative-picker-input"
          placeholder={t("edit.searchPerson")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul className="relative-picker-list">
          <li>
            <button
              className={`relative-picker-option relative-picker-new${activeIdx === 0 ? " highlighted" : ""}`}
              onMouseEnter={() => setActiveIdx(0)}
              onMouseDown={(e) => { e.preventDefault(); onAddNew(); }}
            >
              + {t("edit.addNewPerson")}
            </button>
          </li>
          {options.map((o, i) => (
            <li key={o.id}>
              <button
                className={`relative-picker-option${i + 1 === activeIdx ? " highlighted" : ""}`}
                onMouseEnter={() => setActiveIdx(i + 1)}
                onMouseDown={(e) => { e.preventDefault(); onPickExisting(o.id); }}
              >
                {o.text}
              </button>
            </li>
          ))}
          {options.length === 0 && query.trim() && (
            <li className="relative-picker-empty muted">{t("start.noMatches")}</li>
          )}
        </ul>
      </div>
    </div>
  );
}
