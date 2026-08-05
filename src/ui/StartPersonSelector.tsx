import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Individual } from "../gedcom/types";
import { nameSearchText } from "../match/relatives";
import { lifespanTooltipOf, lifespanWithAge } from "../gedcom/age";
import { xrefLabel } from "../gedcom/nameDisplay";
import { foldSearch } from "./globalSearch";
import { useNameOf, useSettingsSlice } from "./SettingsContext";
import { sexClass } from "./sex";
import { SearchIcon } from "./icons/SearchIcon";

/** The preferences the rows read — the same the person cards honour, so a name
 *  reads identically wherever it appears. */
const SETTINGS_KEYS = ["showAge", "showXref"] as const;

interface Props {
  individuals: Map<string, Individual>;
  startId: string | undefined;
  onChange: (id: string) => void;
  onClear?: () => void;
  /** When it turns true, focus the input so the user can type right away. */
  autoFocus?: boolean;
  /** Called once after an autoFocus has been honoured, so it isn't repeated. */
  onAutoFocused?: () => void;
  /** Input placeholder shown when no person is selected. Defaults to the start-person wording. */
  placeholder?: string;
  /** Input tooltip. Defaults to the start-person wording. */
  tooltip?: string;
  /** Icon to show left of the input. Defaults to "house". */
  icon?: "house" | "search";
  /** When set (and a start person is chosen), the start icon becomes a button that
   *  navigates back to the start person. Only meaningful with `icon="house"`. */
  onStartClick?: () => void;
  /** When true (default), the selected person's name is shown as the input
   * placeholder. Set false for a pure search field that should always show the
   * generic `placeholder` hint instead (e.g. Edit's "jump to person" search). */
  selectedAsPlaceholder?: boolean;
}

const MAX_RESULTS = 50;

/**
 * Optional, filterable picker for an individual. Originally built for setting
 * the main's start person (which makes the matcher compute each match's
 * relationship distance and sort by it); also reused in Edit mode as a
 * generic "jump to person" picker via the `placeholder`/`tooltip` props.
 */
export function StartPersonSelector({
  individuals,
  startId,
  onChange,
  onClear,
  autoFocus,
  onAutoFocused,
  placeholder,
  tooltip,
  icon = "house",
  onStartClick,
  selectedAsPlaceholder = true,
}: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  // Index of the keyboard-highlighted option in `filtered`, for up/down nav.
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const { t } = useTranslation();
  const nameOf = useNameOf();
  const settings = useSettingsSlice(SETTINGS_KEYS);

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
      onAutoFocused?.();
    }
  }, [autoFocus, onAutoFocused]);

  // The option text honours the user's name-display settings (order, uppercase,
  // married surname); `search` covers *all* of a person's names (married, aka,
  // maiden, nickname…) plus their years, so they're found however they're shown.
  const options = useMemo(
    () =>
      [...individuals.values()]
        .map((i) => {
          const span = lifespanWithAge(i, settings.showAge);
          const name = nameOf(i);
          const search = foldSearch(`${nameSearchText(i)} ${span} ${i.id}`);
          return {
            id: i.id,
            name,
            span,
            sex: i.sex,
            xref: xrefLabel(i.id),
            text: span ? `${name} ${span}` : name,
            title: lifespanTooltipOf(i, settings.showAge, t),
            search,
          };
        })
        .sort((a, b) => a.text.localeCompare(b.text)),
    [individuals, nameOf, settings.showAge, t],
  );

  const filtered = useMemo(() => {
    // Every whitespace-separated term must appear somewhere in the person's name
    // text, in any order — so "rezka jeko" finds someone with nick "Rezka" and
    // married name "Jekovec" even though those live in different name fields.
    const terms = foldSearch(query.trim()).split(/\s+/).filter(Boolean);
    const base = terms.length
      ? options.filter((o) => terms.every((term) => o.search.includes(term)))
      : options;
    return base.slice(0, MAX_RESULTS);
  }, [options, query]);

  const current = options.find((o) => o.id === startId);

  // Reset the highlight to the top whenever the result set changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Keep the highlighted option scrolled into view as it moves.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  function confirm(id: string) {
    onChange(id);
    setQuery("");
    setOpen(false);
    inputRef.current?.blur(); // deactivate the field once a person is chosen
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      const choice = filtered[activeIndex];
      if (choice) {
        e.preventDefault();
        confirm(choice.id);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const glyph =
    icon === "house" ? (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3 9.5 12 3l9 6.5" />
        <path d="M5 10v10h14V10" />
      </svg>
    ) : (
      <SearchIcon size={14} />
    );

  // When a start person is set and a handler is provided, the start icon is a
  // button that jumps back to that person; otherwise it's a static glyph.
  const clickableStart = icon === "house" && !!startId && !!onStartClick;

  return (
    <div className={startId ? "start-selector" : "start-selector unset"}>
      <div className="start-control">
        {clickableStart ? (
          <button type="button" className="start-icon start-icon-btn" title={t("start.goto")} onClick={onStartClick}>
            {glyph}
          </button>
        ) : (
          <span className="start-icon" aria-hidden="true">
            {glyph}
          </span>
        )}
        <input
          ref={inputRef}
          type="text"
          placeholder={selectedAsPlaceholder && current ? current.text : placeholder ?? t("start.set")}
          title={tooltip ?? t("start.tooltip")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown}
        />
        {startId && onClear && (
          <button
            className="start-clear"
            title={t("start.clear")}
            onClick={() => {
              setQuery("");
              onClear();
            }}
          >
            ×
          </button>
        )}
        {open && query.trim() !== "" && (
          <ul className="start-options" ref={listRef}>
            {filtered.map((o, i) => {
              const cls = [
                "start-option",
                o.id === startId ? "active" : "",
                i === activeIndex ? "highlighted" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <li key={o.id}>
                  <button
                    className={cls}
                    data-index={i}
                    title={o.title || undefined}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => confirm(o.id)}
                  >
                    <span className={`person-label ${sexClass(o.sex)}`}>
                      <span className="person-name">{o.name}</span>
                      {settings.showXref && <span className="person-xref gm-data">{o.xref}</span>}
                      {o.span && <span className="person-years gm-data">{o.span}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 && <li className="muted start-empty">{t("start.noMatches")}</li>}
          </ul>
        )}
      </div>
    </div>
  );
}
