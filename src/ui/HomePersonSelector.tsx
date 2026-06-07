import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Individual } from "../gedcom/types";
import { datesTooltipOf } from "../gedcom/lifespan";
import { lifespanLabel } from "../match/relatives";

interface Props {
  individuals: Map<string, Individual>;
  homeId: string | undefined;
  onChange: (id: string) => void;
  onClear?: () => void;
}

const MAX_RESULTS = 50;

/**
 * Optional, filterable picker for the master's home person. Setting one makes
 * the matcher compute each match's relationship distance and sort by it.
 */
export function HomePersonSelector({ individuals, homeId, onChange, onClear }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();

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

  return (
    <div className={homeId ? "home-selector" : "home-selector unset"}>
      <div className="home-control">
        <input
          type="text"
          placeholder={current ? current.text : t("home.set")}
          title={t("home.tooltip")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
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
          <ul className="home-options">
            {filtered.map((o) => (
              <li key={o.id}>
                <button
                  className={o.id === homeId ? "home-option active" : "home-option"}
                  title={o.title || undefined}
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
            {filtered.length === 0 && <li className="muted home-empty">{t("home.noMatches")}</li>}
          </ul>
        )}
      </div>
    </div>
  );
}
