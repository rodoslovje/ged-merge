import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Individual } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { nameSearchText } from "../../match/relatives";
import { lifespanTooltipOf, lifespanWithAge } from "../../gedcom/age";
import { xrefLabel } from "../../gedcom/nameDisplay";
import { useNameOf, useSettingsSlice } from "../SettingsContext";
import { sexClass } from "../sex";
import { foldSearch, matchesTerms, queryTerms } from "../globalSearch";

/** The preferences the rows read — the same ones the person cards honour, so a
 *  name reads identically whether it sits on a card or in this list. */
const SETTINGS_KEYS = ["showAge", "showXref"] as const;

/** Rows offered at once — a page the user can scan, not the whole file. */
const MAX_OPTIONS = 10;

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
  /** Create a new person; the typed query rides along to seed their name. */
  onAddNew: (typedName: string) => void;
  onCancel: () => void;
  t: Translate;
}) {
  const nameOf = useNameOf();
  const settings = useSettingsSlice(SETTINGS_KEYS);
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

  // Every person, prepared once and left in name order. Formatting a name
  // resolves married surnames from the whole dataset and reading a lifespan
  // parses dates, so doing this per keystroke — as it used to — cost the length
  // of the file on every letter typed.
  const people = useMemo(
    () =>
      [...individuals.values()]
        .filter((i) => i.id !== excludeId)
        .map((i) => {
          const name = nameOf(i);
          const span = lifespanWithAge(i, settings.showAge);
          return {
            id: i.id,
            indi: i,
            name,
            span,
            sex: i.sex,
            xref: xrefLabel(i.id),
            // Searchable on every name the person carries, not just the one on
            // show: a maiden name still finds them while married names are
            // displayed, and the record id finds them outright.
            search: foldSearch(`${nameSearchText(i)} ${name} ${span} ${i.id}`),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name) || a.span.localeCompare(b.span)),
    [individuals, excludeId, nameOf, settings.showAge],
  );

  // Typing only walks that list, and stops at the first full page of matches.
  // Each word of the query is matched on its own, so a few opening letters of
  // the given name and of the surname are enough: "sebas kala" finds
  // "Sebastjan Kalan", and the two may sit in different name fields.
  const options = useMemo(() => {
    const terms = queryTerms(query);
    const shown: typeof people = [];
    for (const p of people) {
      if (!matchesTerms(p.search, terms)) continue;
      shown.push(p);
      if (shown.length === MAX_OPTIONS) break;
    }
    return shown;
  }, [people, query]);

  useEffect(() => { setActiveIdx(0); }, [query]);

  const totalItems = options.length + 1; // options + "Add new"

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { onCancel(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, totalItems - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
    if (e.key === "Enter") {
      e.preventDefault();
      if (activeIdx === 0) onAddNew(query.trim());
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
              onMouseDown={(e) => { e.preventDefault(); onAddNew(query.trim()); }}
            >
              + {t("edit.addNewPerson")}
            </button>
          </li>
          {options.map((o, i) => (
            <li key={o.id}>
              <button
                className={`relative-picker-option${i + 1 === activeIdx ? " highlighted" : ""}`}
                title={lifespanTooltipOf(o.indi, settings.showAge, t)}
                onMouseEnter={() => setActiveIdx(i + 1)}
                onMouseDown={(e) => { e.preventDefault(); onPickExisting(o.id); }}
              >
                <span className={`person-label ${sexClass(o.sex)}`}>
                  <span className="person-name">{o.name}</span>
                  {settings.showXref && <span className="person-xref gm-data">{o.xref}</span>}
                  {o.span && <span className="person-years gm-data">{o.span}</span>}
                </span>
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
