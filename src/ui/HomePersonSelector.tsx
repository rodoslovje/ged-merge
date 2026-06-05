import { useMemo, useState } from "react";
import type { Individual } from "../gedcom/types";
import { label } from "../match/relatives";

interface Props {
  individuals: Map<string, Individual>;
  homeId: string | undefined;
  onChange: (id: string) => void;
}

const MAX_RESULTS = 50;

/** A filterable picker for the master's home person (scales to large trees). */
export function HomePersonSelector({ individuals, homeId, onChange }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const options = useMemo(
    () =>
      [...individuals.values()]
        .map((i) => ({ id: i.id, text: label(i) }))
        .sort((a, b) => a.text.localeCompare(b.text)),
    [individuals],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? options.filter((o) => o.text.toLowerCase().includes(q)) : options;
    return base.slice(0, MAX_RESULTS);
  }, [options, query]);

  const current = options.find((o) => o.id === homeId);

  return (
    <div className="home-selector">
      <label className="home-label">Home person</label>
      <div className="home-current">{current ? current.text : "(none selected)"}</div>
      <input
        type="text"
        placeholder="Search to change…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
      />
      {open && query.trim() !== "" && (
        <ul className="home-options">
          {filtered.map((o) => (
            <li key={o.id}>
              <button
                className={o.id === homeId ? "home-option active" : "home-option"}
                onClick={() => {
                  onChange(o.id);
                  setQuery("");
                  setOpen(false);
                }}
              >
                {o.text}
              </button>
            </li>
          ))}
          {filtered.length === 0 && <li className="muted home-empty">No matches</li>}
        </ul>
      )}
    </div>
  );
}
