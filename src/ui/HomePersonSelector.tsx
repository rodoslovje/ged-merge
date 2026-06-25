import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Individual } from "../gedcom/types";
import { datesTooltipOf } from "../gedcom/lifespan";
import { lifespanLabel } from "../match/relatives";

interface Props {
  individuals: Map<string, Individual>;
  homeId: string | undefined;
  onChange: (id: string) => void;
  onClear?: () => void;
  /** When it turns true, focus the input so the user can type right away. */
  autoFocus?: boolean;
  /** Called once after an autoFocus has been honoured, so it isn't repeated. */
  onAutoFocused?: () => void;
  /** Input placeholder shown when no person is selected. Defaults to the home-person wording. */
  placeholder?: string;
  /** Input tooltip. Defaults to the home-person wording. */
  tooltip?: string;
  /** Icon to show left of the input. Defaults to "home". */
  icon?: "home" | "search";
  /** When true (default), the selected person's name is shown as the input
   * placeholder. Set false for a pure search field that should always show the
   * generic `placeholder` hint instead (e.g. Edit's "jump to person" search). */
  selectedAsPlaceholder?: boolean;
}

const MAX_RESULTS = 50;

/**
 * Optional, filterable picker for an individual. Originally built for setting
 * the master's home person (which makes the matcher compute each match's
 * relationship distance and sort by it); also reused in Edit mode as a
 * generic "jump to person" picker via the `placeholder`/`tooltip` props.
 */
export function HomePersonSelector({
  individuals,
  homeId,
  onChange,
  onClear,
  autoFocus,
  onAutoFocused,
  placeholder,
  tooltip,
  icon = "home",
  selectedAsPlaceholder = true,
}: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  // Index of the keyboard-highlighted option in `filtered`, for up/down nav.
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const { t } = useTranslation();

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
      onAutoFocused?.();
    }
  }, [autoFocus, onAutoFocused]);

  const options = useMemo(
    () =>
      [...individuals.values()]
        .map((i) => ({ id: i.id, text: lifespanLabel(i), title: datesTooltipOf(i) }))
        .sort((a, b) => a.text.localeCompare(b.text)),
    [individuals],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? options.filter((o) => o.text.toLowerCase().includes(q)) : options;
    return base.slice(0, MAX_RESULTS);
  }, [options, query]);

  const current = options.find((o) => o.id === homeId);

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

  return (
    <div className={homeId ? "home-selector" : "home-selector unset"}>
      <div className="home-control">
        {icon === "home" ? (
          <svg
            className="home-icon"
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
          <svg
            className="home-icon"
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
            <circle cx="11" cy="11" r="7" />
            <line x1="16.5" y1="16.5" x2="22" y2="22" />
          </svg>
        )}
        <input
          ref={inputRef}
          type="text"
          placeholder={selectedAsPlaceholder && current ? current.text : placeholder ?? t("home.set")}
          title={tooltip ?? t("home.tooltip")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown}
        />
        {homeId && onClear && (
          <button
            className="home-clear"
            title={t("home.clear")}
            onClick={() => {
              setQuery("");
              onClear();
            }}
          >
            ×
          </button>
        )}
        {open && query.trim() !== "" && (
          <ul className="home-options" ref={listRef}>
            {filtered.map((o, i) => {
              const cls = [
                "home-option",
                o.id === homeId ? "active" : "",
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
                    {o.text}
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 && <li className="muted home-empty">{t("home.noMatches")}</li>}
          </ul>
        )}
      </div>
    </div>
  );
}
