import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DownloadIcon } from "./icons/DownloadIcon";

// The chart-toolbar "Export ▾" dropdown: one button for every download format
// instead of a growing row of per-format buttons. New formats (PNG, reports,
// branch GEDCOM, …) become new items here, not new toolbar buttons. Mirrors the
// ChartSettings gear's popover behavior (toggle button + outside-click close).

export interface ExportItem {
  key: string;
  label: string;
  /** Small format glyph rendered before the label. */
  icon?: React.ReactNode;
  /** Tooltip explaining the format (e.g. the PDF item routes via the print dialog). */
  title?: string;
  onSelect: () => void;
}

export function ExportMenu({ items, disabled }: { items: ExportItem[]; disabled?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close the menu on an outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="export-menu" ref={ref}>
      <button
        className={`tree-open-btn tree-export-btn${open ? " open" : ""}`}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("export.tooltip")}
        aria-label={t("export.button")}
      >
        <DownloadIcon /> <span className="export-menu-label">{t("export.button")}</span> <span className="export-menu-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="export-menu-popover" role="menu" aria-label={t("export.button")}>
          {items.map((item) => (
            <button
              key={item.key}
              role="menuitem"
              className="export-menu-item"
              title={item.title}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
