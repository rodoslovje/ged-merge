import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Individual } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { nameSearchText } from "../../match/relatives";
import { lifespanTooltipOf, lifespanWithAge } from "../../gedcom/age";
import { xrefLabel } from "../../gedcom/nameDisplay";
import { useNameOf, useSettingsSlice } from "../SettingsContext";
import { sexClass } from "../sex";
import { foldSearch, matchesTerms, queryTerms } from "../globalSearch";
import { handleListKey } from "../../keyboard/useListKeyboard";

/** The preferences the rows read — the same ones the person cards honour, so a
 *  name reads identically whether it sits on a card or in this list. */
const SETTINGS_KEYS = ["showAge", "showXref"] as const;

/** Rows offered at once — a page the user can scan, not the whole file. */
const MAX_OPTIONS = 10;

/** One person as the picker lists them: what is shown, and what is searched. */
export interface PersonOption {
  id: string;
  indi: Individual;
  name: string;
  span: string;
  sex: Individual["sex"];
  xref: string;
  search: string;
}

/**
 * Every person the file holds, prepared once and left in name order.
 *
 * Formatting a name resolves married surnames from the whole dataset and
 * reading a lifespan parses dates, so doing this per keystroke — as it used to
 * — cost the length of the file on every letter typed. `enabled` is for a
 * caller that only sometimes searches: an associate's name field builds the
 * list when it is typed in, not on every row of a record naming nine people.
 */
export function usePersonOptions(
  individuals: Map<string, Individual>,
  excludeId: string,
  enabled = true,
): PersonOption[] {
  const nameOf = useNameOf();
  const settings = useSettingsSlice(SETTINGS_KEYS);
  return useMemo(
    () =>
      enabled
        ? [...individuals.values()]
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
                // Searchable on every name the person carries, not just the one
                // on show: a maiden name still finds them while married names
                // are displayed, and the record id finds them outright.
                search: foldSearch(`${nameSearchText(i)} ${name} ${span} ${i.id}`),
              };
            })
            .sort((a, b) => a.name.localeCompare(b.name) || a.span.localeCompare(b.span))
        : [],
    [enabled, individuals, excludeId, nameOf, settings.showAge],
  );
}

/**
 * The first page of people the query answers for — a page to scan, not the
 * whole file. Each word is matched on its own, so a few opening letters of the
 * given name and of the surname are enough: "sebas kala" finds "Sebastjan
 * Kalan", and the two may sit in different name fields.
 */
export function matchPersonOptions(people: PersonOption[], query: string, max = MAX_OPTIONS): PersonOption[] {
  const terms = queryTerms(query);
  const shown: PersonOption[] = [];
  for (const p of people) {
    if (!matchesTerms(p.search, terms)) continue;
    shown.push(p);
    if (shown.length === max) break;
  }
  return shown;
}

/** One row of that list, wherever it is drawn. */
export function PersonOptionRow({
  option,
  highlighted,
  onHighlight,
  onPick,
  t,
}: {
  option: PersonOption;
  highlighted: boolean;
  onHighlight: () => void;
  onPick: () => void;
  t: Translate;
}) {
  const settings = useSettingsSlice(SETTINGS_KEYS);
  return (
    <button
      type="button"
      className={`relative-picker-option${highlighted ? " highlighted" : ""}`}
      title={lifespanTooltipOf(option.indi, settings.showAge, t)}
      onMouseEnter={onHighlight}
      onFocus={onHighlight}
      // mousedown only keeps the search box's focus; the pick is the click, so
      // Enter on a row reached with Tab picks it too.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
    >
      <span className={`person-label ${sexClass(option.sex)}`}>
        <span className="person-name">{option.name}</span>
        {settings.showXref && <span className="person-xref gm-data">{option.xref}</span>}
        {option.span && <span className="person-years gm-data">{option.span}</span>}
      </span>
    </button>
  );
}

/** Inline picker that lets the user either search for an existing person or add a new one. */
export function RelativePickerCard({
  roleLabel,
  individuals,
  excludeId,
  onPickExisting,
  onAddNew,
  newLabel,
  onCancel,
  t,
}: {
  roleLabel?: string;
  individuals: Map<string, Individual>;
  excludeId: string;
  onPickExisting: (id: string) => void;
  /** Create a new person; the typed query rides along to seed their name.
   *  Left out where the caller has nothing to create — a 5.5.1 file cannot
   *  record an associate it holds no person for, so the row is not offered. */
  onAddNew?: (typedName: string) => void;
  /** Wording for that row, where "add a new person" is not what it does. */
  newLabel?: string;
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
    // Registered a tick late, on purpose. A control that opens this picker may
    // itself act on mousedown rather than click — the "+ Add" menu's options do,
    // so selection beats the input blur/commit cycle — and that mousedown is
    // still travelling towards the document while this effect runs. Attaching
    // synchronously let the very click that opened the picker dismiss it again:
    // it mounted and vanished within one event, and the row looked inert.
    const timer = setTimeout(() => document.addEventListener("mousedown", onMouseDown), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [onCancel]);

  const people = usePersonOptions(individuals, excludeId);
  const options = useMemo(() => matchPersonOptions(people, query), [people, query]);

  useEffect(() => { setActiveIdx(0); }, [query]);

  // The "add new" row leads the list where the caller offers one; without it
  // the options start at 0, and every index below shifts with them.
  const offset = onAddNew ? 1 : 0;
  const totalItems = options.length + offset;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { onCancel(); return; }
    handleListKey(e, {
      count: totalItems,
      index: activeIdx,
      setIndex: setActiveIdx,
      onEnter: (i) => {
        if (onAddNew && i === 0) onAddNew(query.trim());
        else {
          const picked = options[i - offset];
          if (picked) onPickExisting(picked.id);
        }
      },
    });
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
          {onAddNew && (
            <li>
              <button
                type="button"
                className={`relative-picker-option relative-picker-new${activeIdx === 0 ? " highlighted" : ""}`}
                onMouseEnter={() => setActiveIdx(0)}
                onFocus={() => setActiveIdx(0)}
                // mousedown only keeps the search box's focus; the pick is the
                // click, so Enter on a row reached with Tab picks it too.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onAddNew(query.trim())}
              >
                + {newLabel ?? t("edit.addNewPerson")}
              </button>
            </li>
          )}
          {options.map((o, i) => (
            <li key={o.id}>
              <PersonOptionRow
                option={o}
                highlighted={i + offset === activeIdx}
                onHighlight={() => setActiveIdx(i + offset)}
                onPick={() => onPickExisting(o.id)}
                t={t}
              />
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
