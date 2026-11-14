import { useId, useMemo, useRef, useState } from "react";

export interface SearchSelectOption {
  value: string;
  label: string;
}

/** How many matches the list renders at once; typing narrows the rest in. */
const SHOWN = 200;

/** Lower-cased, accent-free text, so »smartin« finds »Šmartin«. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * A select you type into, for pickers over long lists (a file's images or
 * sources), where searching beats scrolling: the field shows the chosen option
 * (or the placeholder), and typing in it lists the options whose label
 * contains the text, case and accents ignored. It looks and behaves like the
 * person search of Edit's relative picker — the same list, rows and "+ new"
 * row on top (`pinned`, always shown). Arrow keys move, Enter picks, Escape
 * leaves the choice as it was.
 */
export function SearchSelect({
  value,
  options,
  pinned = [],
  placeholder,
  emptyLabel,
  onChange,
  className,
}: {
  value: string;
  options: SearchSelectOption[];
  pinned?: SearchSelectOption[];
  placeholder: string;
  /** Shown when typing matches nothing. */
  emptyLabel: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const current = [...pinned, ...options].find((o) => o.value === value);

  const matches = useMemo(() => {
    const q = fold(query.trim());
    return q ? options.filter((o) => fold(o.label).includes(q)) : options;
  }, [options, query]);
  const shown = [...pinned, ...matches.slice(0, SHOWN)];

  function pick(o: SearchSelectOption, input: HTMLInputElement | null) {
    setOpen(false);
    setQuery("");
    onChange(o.value);
    input?.blur();
  }

  /** Move the highlight and keep it in view — scrolling the list only. */
  function highlight(i: number) {
    setActive(i);
    const list = listRef.current;
    const row = list?.children[i] as HTMLElement | undefined;
    if (!list || !row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
    }
  }

  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className={`search-select${className ? ` ${className}` : ""}`}>
      <input
        ref={inputRef}
        type="text"
        className="search-select-input"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        placeholder={current?.label ?? placeholder}
        title={current?.label}
        value={open ? query : (current?.label ?? "")}
        onFocus={() => {
          setOpen(true);
          setQuery("");
          // The first match, not the "+ new" row: Enter after typing picks what was found.
          setActive(pinned.length);
        }}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(pinned.length);
          if (listRef.current) listRef.current.scrollTop = 0;
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            highlight(Math.min(shown.length - 1, active + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            highlight(Math.max(0, active - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (shown[active]) pick(shown[active], e.currentTarget);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.blur();
          }
        }}
      />
      {open && (
        <ul ref={listRef} id={listId} className="relative-picker-list start-options" role="listbox">
          {shown.map((o, i) => (
            <li key={o.value} role="option" aria-selected={o.value === value}>
              <button
                type="button"
                tabIndex={-1}
                className={
                  "relative-picker-option" +
                  (i < pinned.length ? " relative-picker-new" : "") +
                  (i === active ? " highlighted" : "")
                }
                onMouseEnter={() => setActive(i)}
                // Mouse-down keeps the field's focus until the pick is made.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o, inputRef.current);
                }}
              >
                {i < pinned.length ? `+ ${o.label}` : o.label}
              </button>
            </li>
          ))}
          {matches.length === 0 && <li className="relative-picker-empty muted">{emptyLabel}</li>}
          {matches.length > SHOWN && <li className="relative-picker-empty muted">+{matches.length - SHOWN}</li>}
        </ul>
      )}
    </div>
  );
}
