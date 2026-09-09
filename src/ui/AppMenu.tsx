import { useTranslation } from "react-i18next";
import { usePopoverKeyboard } from "../keyboard/usePopoverKeyboard";
import { AddPersonIcon } from "./icons/AddPersonIcon";
import { ChartIcon } from "./icons/ChartIcon";
import { GearIcon } from "./icons/GearIcon";
import { HelpIcon } from "./icons/HelpIcon";
import { SearchIcon } from "./icons/SearchIcon";

// The phone header's ☰ menu. On a narrow screen the header can hold the brand,
// the mode tabs and one button — not the file pills, the start-person picker and
// four icon buttons as well. Everything that doesn't fit lives here, in one
// panel, rather than being hidden: the file pills used to be `display: none`
// below 880px, which left no way at all to see or change the loaded files.
//
// Toggle-button + outside-click popover, like ExportMenu / ChartSettings, with
// the same menu keyboard. Open state is owned by the caller so it can open the
// panel by itself (the app pops it when no start person could be picked
// automatically).

export interface AppMenuFile {
  /** "Main" / "Incoming". */
  label: string;
  fileName: string;
  accent: "main" | "incoming";
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: AppMenuFile[];
  /** Opens the file-info panel, where the loaders live. */
  onOpenFiles: () => void;
  /** The start-person picker, rendered inside the panel on a phone. */
  startSelector?: React.ReactNode;
  onCharts?: () => void;
  onSearch?: () => void;
  onAddPerson?: () => void;
  onSettings: () => void;
  /** The keyboard-shortcut sheet — a phone has no `?` key to press. */
  onShortcuts: () => void;
}

export function AppMenu({
  open,
  onOpenChange,
  files,
  onOpenFiles,
  startSelector,
  onCharts,
  onSearch,
  onAddPerson,
  onSettings,
  onShortcuts,
}: Props) {
  const { t } = useTranslation();
  const { containerRef, triggerRef, close, onTriggerKeyDown } = usePopoverKeyboard(open, onOpenChange, { arrows: true });

  /** Run an action and close the panel behind it. */
  function pick(run: () => void) {
    close();
    run();
  }

  return (
    <div className="app-menu" ref={containerRef}>
      <button
        ref={triggerRef}
        className={`nav-btn icon-only app-menu-btn${open ? " open" : ""}`}
        onClick={() => onOpenChange(!open)}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("menu.title")}
        aria-label={t("menu.title")}
      >
        <span className="app-menu-glyph" aria-hidden="true">☰</span>
      </button>
      {open && (
        <div className="app-menu-panel" role="menu" aria-label={t("menu.title")}>
          {files.length > 0 && (
            <div className="app-menu-group">
              <p className="app-menu-label">{t("menu.files")}</p>
              {files.map((f) => (
                <button
                  key={f.accent}
                  role="menuitem"
                  className={`app-menu-file gm-file ${f.accent}`}
                  onClick={() => pick(onOpenFiles)}
                >
                  <span className="app-menu-file-name">{f.fileName}</span>
                  <span className="app-menu-file-role">{f.label}</span>
                </button>
              ))}
              <button role="menuitem" className="app-menu-item app-menu-files-more" onClick={() => pick(onOpenFiles)}>
                {t("menu.files.manage")}
              </button>
            </div>
          )}
          {startSelector && (
            <div className="app-menu-group">
              <p className="app-menu-label">{t("menu.start")}</p>
              {startSelector}
            </div>
          )}
          <div className="app-menu-group">
            {onCharts && (
              <button role="menuitem" className="app-menu-item" onClick={() => pick(onCharts)}>
                <ChartIcon size={17} /> {t("edit.charts.button")}
              </button>
            )}
            {onSearch && (
              <button role="menuitem" className="app-menu-item" onClick={() => pick(onSearch)}>
                <SearchIcon size={17} /> {t("globalSearch.title")}
              </button>
            )}
            {onAddPerson && (
              <button role="menuitem" className="app-menu-item" onClick={() => pick(onAddPerson)}>
                <AddPersonIcon size={17} /> {t("edit.addNewPerson")}
              </button>
            )}
            <button role="menuitem" className="app-menu-item" onClick={() => pick(onSettings)}>
              <GearIcon size={17} /> {t("settings.title")}
            </button>
            <button role="menuitem" className="app-menu-item" onClick={() => pick(onShortcuts)}>
              <HelpIcon size={17} /> {t("shortcuts.title")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
